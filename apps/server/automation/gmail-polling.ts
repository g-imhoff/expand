import { Effect, Layer } from "effect"
import { HttpClient } from "effect/http"
import { SqlClient } from "effect/sql/SqlClient"
import { decodeJson, PersonalScope, sameDefinition } from "@expand/contracts/automation"
import type { IntegrationConfiguration, RoutineConfiguration } from "@expand/contracts/automation"
import { emailTriggerReference, gmailIntegrationReference } from "@expand/contracts/automation/gmail"
import { CredentialRepository } from "./credential-repository.js"
import { acknowledgeGmailPoll, pollGmailInbox } from "./gmail-connector.js"
import { StorageError, encodeJson } from "./persistence-models.js"
import type { Target } from "./execution-repository.js"
import type { AutomationWorkerEnvironment } from "./worker.js"

export interface GmailPollingOptions {
  readonly pollIntervalMs: number
}

export const DefaultGmailPollingOptions: GmailPollingOptions = { pollIntervalMs: 60000 }

export const pollGmailOnce = Effect.fn("GmailPolling.pollOnce")(function*(environment: AutomationWorkerEnvironment) {
  const rows = yield* environment.services.sql<{ owner_id: string; project_id: string }>`
    SELECT DISTINCT owner_id, project_id FROM automation_routines WHERE status='enabled'
  `.pipe(Effect.mapError(() => new StorageError({ code: "storage", message: "Gmail scope discovery failed" })))
  let received = 0
  for (const row of rows) {
    const scope = yield* decodeJson(PersonalScope, { ownerId: row.owner_id, projectId: row.project_id }).pipe(
      Effect.mapError(() => new StorageError({ code: "invalid", message: "Stored scope is not usable" }))
    )
    const heads = yield* environment.services.configurations.listHeads(scope)
    const integrations = new Map<string, { integration: IntegrationConfiguration; routines: Array<RoutineConfiguration> }>()
    for (const head of heads) {
      if (head.head.status !== "enabled") continue
      const due = yield* environment.routines.assertDue(scope, head.routineId).pipe(Effect.option)
      if (due._tag === "None") continue
      const routine = due.value.configuration
      if (!sameDefinition(routine.process.trigger.definition, emailTriggerReference)) continue
      const reference = routine.process.trigger.integration
      if (!sameDefinition(reference.definition, gmailIntegrationReference)) continue
      const stored = yield* environment.services.configurations.getIntegration(scope, reference.id).pipe(Effect.option)
      if (stored._tag === "None" || stored.value === null || !sameDefinition(stored.value.configuration.definition, gmailIntegrationReference)) continue
      const group = integrations.get(reference.id)
      if (group === undefined) integrations.set(reference.id, { integration: stored.value.configuration, routines: [routine] })
      else group.routines.push(routine)
    }
    for (const group of integrations.values()) {
      received += yield* pollIntegration(environment, scope, group.integration, group.routines).pipe(
        Effect.catch(() => Effect.logWarning("gmail receipt polling failed", { integrationId: group.integration.id }).pipe(Effect.as(0)))
      )
    }
  }
  return received
})

export const startGmailPolling = Effect.fn("GmailPolling.start")(function*(
  environment: AutomationWorkerEnvironment,
  options: GmailPollingOptions = DefaultGmailPollingOptions
) {
  const interval = Number.isSafeInteger(options.pollIntervalMs) && options.pollIntervalMs >= 1000 && options.pollIntervalMs <= 300000
    ? options.pollIntervalMs
    : DefaultGmailPollingOptions.pollIntervalMs
  while (true) {
    yield* pollGmailOnce(environment).pipe(Effect.catch(() => Effect.logWarning("gmail receipt scope discovery failed")))
    yield* Effect.sleep(`${interval} millis`)
  }
})

const pollIntegration = Effect.fn("GmailPolling.pollIntegration")(function*(
  environment: AutomationWorkerEnvironment,
  scope: PersonalScope,
  integration: IntegrationConfiguration,
  routines: ReadonlyArray<RoutineConfiguration>
) {
  const services = environment.services
  const layer = Layer.mergeAll(
    Layer.succeed(CredentialRepository, services.credentials),
    Layer.succeed(HttpClient.HttpClient, services.http),
    Layer.succeed(SqlClient, services.sql)
  )
  const polled = yield* pollGmailInbox(scope, integration, environment.gmailOptions).pipe(Effect.provide(layer))
  yield* services.sql.withTransaction(Effect.gen(function*() {
    for (const message of polled.fresh) {
      const id = `gmail:${integration.id}:${message.id}`
      const payload = { messageId: message.id, threadId: message.threadId }
      const targets: Array<Target> = []
      for (const routine of routines) {
        const actionGrants = Object.values(routine.process.actions).flat().map((step) => {
          const definition = environment.registry.catalog().definitions.find((entry) => entry.kind === "action" && sameDefinition(entry.definition, step.action))
          return {
            action: step.action,
            integrationId: step.integration.id,
            capabilities: definition?.kind === "action" ? definition.capabilities : []
          }
        })
        targets.push({
          jobId: `${id}:${routine.reference.routineId}:job`,
          run: {
            schemaVersion: 1,
            kind: "run",
            id: `${id}:${routine.reference.routineId}:run`,
            scope,
            configuration: routine.reference,
            input: { kind: "input-reference", id },
            mode: "live",
            authority: {
              schemaVersion: 1,
              kind: "invocation-authority",
              scope,
              configuration: routine.reference,
              integrationIds: routine.integrations.map((entry) => entry.id),
              actionGrants
            },
            state: { kind: "queued" },
            actions: []
          }
        })
      }
      yield* services.executions.ingest({
        delivery: {
          schemaVersion: 1,
          id,
          scope,
          integration: { id: integration.id, definition: integration.definition },
          externalId: message.id,
          trigger: emailTriggerReference,
          payload
        },
        raw: new TextEncoder().encode(encodeJson(payload)),
        targets
      })
    }
    yield* acknowledgeGmailPoll(scope, integration.id, polled).pipe(Effect.provide(layer))
  })).pipe(Effect.mapError(() => new StorageError({ code: "storage", message: "Gmail receipt ingestion failed" })))
  return polled.fresh.length
})

