import { Effect, Schema } from "effect"
import {
  AutomationError,
  LocalId,
  PersonalScope,
  sameDefinition,
} from "@expand/contracts/automation"
import { ExecutionRepository } from "./execution-repository.js"
import { RoutineService } from "./routine-service.js"
import { StorageError, canonical, encodeJson } from "./persistence-models.js"
import type { AutomationRegistry } from "./registry.js"

export interface ManualTriggerServices {
  readonly routines: RoutineService["Service"]
  readonly executions: ExecutionRepository["Service"]
}

export interface ManualStartInput {
  readonly scope: PersonalScope
  readonly routineId: string
  readonly payload: unknown
  readonly idempotencyKey: string
}

export interface ManualStartResult {
  readonly deliveryId: string
  readonly jobIds: ReadonlyArray<string>
  readonly runIds: ReadonlyArray<string>
}

export const makeManualStartHandler = (services: ManualTriggerServices, registry: AutomationRegistry) => {
  const start = (input: ManualStartInput): Effect.Effect<ManualStartResult, AutomationError | StorageError> =>
    Effect.gen(function* () {
      const scope = yield* Schema.decodeUnknownEffect(PersonalScope, { onExcessProperty: "error" })(input.scope).pipe(
        Effect.mapError(() => new AutomationError({ code: "invalid-reference", message: "scope is not usable" })),
      )
      const routineId = yield* Schema.decodeUnknownEffect(LocalId, { onExcessProperty: "error" })(input.routineId).pipe(
        Effect.mapError(() => new AutomationError({ code: "invalid-reference", message: "routineId is not usable" })),
      )
      const key = yield* Schema.decodeUnknownEffect(LocalId, { onExcessProperty: "error" })(input.idempotencyKey).pipe(
        Effect.mapError(() => new AutomationError({ code: "invalid-reference", message: "idempotencyKey is not usable" })),
      )
      if (key.includes(":")) return yield* new AutomationError({ code: "invalid-reference", message: "idempotencyKey is not usable" })
      const routine = yield* services.routines.assertDue(scope, routineId)
      const revision = routine.configuration
      const payloadSchema = yield* registry.triggerPayloadSchema(revision.process.trigger.definition).pipe(
        Effect.mapError(() => new AutomationError({ code: "missing-definition", message: "Trigger is not registered" })),
      )
      yield* Schema.decodeUnknownEffect(payloadSchema, { onExcessProperty: "error" })(input.payload).pipe(
        Effect.mapError((error) => {
          const field = fieldOf(error)
          return new AutomationError({ code: "invalid-reference", message: `${field} is not usable` })
        }),
      )
      const catalog = registry.catalog()
      const seen = new Set<string>()
      const actionGrants: Array<{ action: { id: string; version: number }; integrationId: string; capabilities: ReadonlyArray<string> }> = []
      for (const steps of Object.values(revision.process.actions)) {
        for (const step of steps) {
          const dedup = encodeJson([step.action.id, step.action.version, step.integration.id])
          if (seen.has(dedup)) continue
          seen.add(dedup)
          const descriptor = catalog.definitions.find((entry) => entry.kind === "action" && sameDefinition(entry.definition, step.action))
          if (descriptor === undefined || descriptor.kind !== "action") {
            return yield* new AutomationError({ code: "invalid-reference", message: "actions is not usable" })
          }
          actionGrants.push({ action: { ...step.action }, integrationId: step.integration.id, capabilities: [...descriptor.capabilities] })
        }
      }
      const triggerIntegrationId = revision.process.trigger.integration.id
      const externalId = `manual:${key}`
      const storedDeliveryId = `${externalId}:${triggerIntegrationId}`
      const jobId = `${storedDeliveryId}:${routineId}:job`
      const runId = `${storedDeliveryId}:${routineId}:run`
      const rawText = canonical({ routineId, payload: input.payload, idempotencyKey: key })
      const raw = new TextEncoder().encode(rawText)
      const delivery = {
        schemaVersion: 1 as const,
        id: storedDeliveryId,
        scope,
        integration: { id: triggerIntegrationId, definition: revision.process.trigger.integration.definition },
        externalId,
        trigger: { ...revision.process.trigger.definition },
        payload: input.payload as never,
      }
      const run = {
        schemaVersion: 1 as const,
        kind: "run" as const,
        id: runId,
        scope,
        configuration: { routineId, revision: revision.reference.revision },
        input: { kind: "input-reference" as const, id: storedDeliveryId },
        mode: "live" as const,
        authority: {
          schemaVersion: 1 as const,
          kind: "invocation-authority" as const,
          scope,
          configuration: { routineId, revision: revision.reference.revision },
          integrationIds: revision.integrations.map((integration) => integration.id),
          actionGrants,
        },
        state: { kind: "queued" as const },
        actions: [],
      }
      const ingestOnce = () => services.executions.ingest({ delivery, raw, targets: [{ jobId, run }] })
      const accepted = yield* ingestOnce().pipe(
        Effect.catch((error) => {
          if (error instanceof StorageError && error.code === "storage") return ingestOnce()
          return Effect.fail(error)
        }),
      )
      return { deliveryId: storedDeliveryId, jobIds: [...accepted.jobIds], runIds: [...accepted.runIds] }
    })
  return { start }
}

const fieldOf = (error: unknown): string => {
  const issues = (error as { readonly issues?: ReadonlyArray<{ readonly path?: ReadonlyArray<unknown> }> })?.issues
  if (Array.isArray(issues) && issues.length > 0) {
    const path = issues[0]?.path
    if (Array.isArray(path) && path.length > 0 && typeof path[0] === "string") return path[0]
  }
  return "payload"
}
