import { createHmac, timingSafeEqual } from "node:crypto"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import {
  CredentialReference,
  IntegrationConfiguration,
  LocalId,
  PersonalScope,
  sameDefinition,
} from "@expand/contracts/automation"
import {
  GithubIssuePayload,
  GithubRepositoryConfiguration,
  githubIntegrationReference,
  githubLabelActionReference,
  githubTriggerReference,
} from "@expand/contracts/automation/github"
import { ConfigurationRepository } from "./configuration-repository.js"
import { CredentialRepository } from "./credential-repository.js"
import { ExecutionRepository } from "./execution-repository.js"
import { StorageError, encodeJson } from "./persistence-models.js"

export interface GithubWebhookServices {
  readonly configurations: ConfigurationRepository["Service"]
  readonly credentials: CredentialRepository["Service"]
  readonly executions: ExecutionRepository["Service"]
  readonly sql: SqlClient
}

export interface GithubWebhookInput {
  readonly deliveryId: string
  readonly event: string
  readonly signature: string | undefined
  readonly raw: Uint8Array
}

export type GithubWebhookOutcome =
  | { readonly status: 200; readonly accepted: false }
  | { readonly status: 200; readonly accepted: true; readonly deliveryId: string; readonly jobIds: ReadonlyArray<string>; readonly runIds: ReadonlyArray<string> }
  | { readonly status: 401; readonly accepted: false }

export const GithubWebhookCredentialSlot = "webhook"

export const verifyGithubSignature = (
  secret: Uint8Array,
  raw: Uint8Array,
  signatureHeader: string | undefined,
): boolean => {
  if (typeof signatureHeader !== "string") return false
  const prefix = "sha256="
  if (!signatureHeader.startsWith(prefix)) return false
  const hex = signatureHeader.slice(prefix.length)
  if (hex.length !== 64) return false
  if (!/^[0-9a-f]{64}$/u.test(hex)) return false
  let expectedHex: string
  try {
    expectedHex = createHmac("sha256", Buffer.from(secret)).update(Buffer.from(raw)).digest("hex")
  } catch {
    return false
  }
  const left = Buffer.from(`${prefix}${expectedHex}`, "utf8")
  const right = Buffer.from(signatureHeader, "utf8")
  return left.length === right.length && timingSafeEqual(left, right)
}

export const decodeWebhookSecret = (secret: Uint8Array): Effect.Effect<string, StorageError> =>
  Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(secret),
    catch: () => new StorageError({ code: "invalid", message: "Webhook secret is not usable" }),
  }).pipe(
    Effect.flatMap((value) =>
      value.length > 0
        ? Effect.succeed(value)
        : Effect.fail(new StorageError({ code: "invalid", message: "Webhook secret is not usable" }))
    ),
  )

export const makeGithubWebhookHandler = (services: GithubWebhookServices) => {
  const handle = (input: GithubWebhookInput): Effect.Effect<GithubWebhookOutcome, StorageError> =>
    Effect.gen(function* () {
      if (typeof input.deliveryId !== "string" || input.deliveryId.length === 0) {
        return { status: 401, accepted: false } as const
      }
      if (typeof input.event !== "string" || input.event.length === 0) {
        return { status: 401, accepted: false } as const
      }
      if (!(input.raw instanceof Uint8Array)) {
        return { status: 401, accepted: false } as const
      }
      if (input.event !== "issues") {
        return { status: 200, accepted: false } as const
      }
      const textOption = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(input.raw),
        catch: () => new StorageError({ code: "invalid", message: "Webhook body is not usable" }),
      }).pipe(Effect.option)
      if (textOption._tag === "None") {
        return { status: 401, accepted: false } as const
      }
      const unknownOption = yield* Schema.decodeUnknownEffect(JsonUnknown, {
        onExcessProperty: "ignore",
      })(textOption.value).pipe(Effect.option)
      if (unknownOption._tag === "None") {
        return { status: 401, accepted: false } as const
      }
      const eventOption = yield* Schema.decodeUnknownEffect(GithubWebhookIssuesEvent, {
        onExcessProperty: "ignore",
      })(unknownOption.value).pipe(Effect.option)
      if (eventOption._tag === "None") {
        return { status: 401, accepted: false } as const
      }
      const event = eventOption.value
      if (event.action !== "opened") {
        return { status: 200, accepted: false } as const
      }
      const owner = event.repository.owner.login
      const repo = event.repository.name
      const payloadValue: { issueNumber: number; title: string; body?: string } = {
        issueNumber: event.issue.number,
        title: event.issue.title,
        ...(typeof event.issue.body === "string" ? { body: event.issue.body } : {}),
      }
      const payloadOption = yield* Schema.decodeUnknownEffect(GithubIssuePayload, {
        onExcessProperty: "error",
      })(payloadValue).pipe(Effect.option)
      if (payloadOption._tag === "None") {
        return { status: 401, accepted: false } as const
      }
      const deliveryOption = yield* Schema.decodeUnknownEffect(LocalId, { onExcessProperty: "error" })(input.deliveryId).pipe(
        Effect.option,
      )
      if (deliveryOption._tag === "None") {
        return { status: 401, accepted: false } as const
      }
      const candidates = yield* findCandidateIntegrations(services, owner, repo)
      if (candidates.length === 0) {
        return { status: 200, accepted: false } as const
      }
      const verified = []
      for (const candidate of candidates) {
        const secret = yield* resolveWebhookSecret(services, candidate.scope, candidate.integration)
        if (secret === null) continue
        if (verifyGithubSignature(secret, input.raw, input.signature)) {
          verified.push(candidate)
        }
      }
      if (verified.length === 0) {
        return { status: 401, accepted: false } as const
      }
      const allJobIds: Array<string> = []
      const allRunIds: Array<string> = []
      let matchedAny = false
      for (const candidate of verified) {
        const routines = yield* findMatchingRoutines(services, candidate.scope, candidate.integration.id)
        if (routines.length === 0) continue
        matchedAny = true
        const storedDeliveryId = `${input.deliveryId}:${candidate.integration.id}`
        const delivery = {
          schemaVersion: 1 as const,
          id: storedDeliveryId,
          scope: candidate.scope,
          integration: { id: candidate.integration.id, definition: candidate.integration.definition },
          externalId: input.deliveryId,
          trigger: { ...githubTriggerReference },
          payload: { ...payloadValue },
        }
        const targets = routines.map((routine) => {
          const routineId = routine.reference.routineId
          const revision = routine.reference.revision
          const jobId = `${storedDeliveryId}:${routineId}:job`
          const runId = `${storedDeliveryId}:${routineId}:run`
          const integrationIds = routine.integrations.map((integration) => integration.id)
          const seen = new Set<string>()
          const actionGrants: Array<{ action: { id: string; version: number }; integrationId: string; capabilities: ReadonlyArray<string> }> = []
          for (const steps of Object.values(routine.process.actions)) {
            for (const step of steps) {
              const key = encodeJson([step.action.id, step.action.version, step.integration.id])
              if (seen.has(key)) continue
              seen.add(key)
              actionGrants.push({
                action: { ...step.action },
                integrationId: step.integration.id,
                capabilities: sameDefinition(step.action, githubLabelActionReference) ? ["label"] : [],
              })
            }
          }
          const run = {
            schemaVersion: 1 as const,
            kind: "run" as const,
            id: runId,
            scope: candidate.scope,
            configuration: { routineId, revision },
            input: { kind: "input-reference" as const, id: storedDeliveryId },
            mode: "live" as const,
            authority: {
              schemaVersion: 1 as const,
              kind: "invocation-authority" as const,
              scope: candidate.scope,
              configuration: { routineId, revision },
              integrationIds: [...integrationIds],
              actionGrants,
            },
            state: { kind: "queued" as const },
            actions: [],
          }
          return { jobId, run }
        })
        const ingestOnce = () => services.executions.ingest({ delivery, raw: input.raw, targets })
        const accepted = yield* ingestOnce().pipe(
          Effect.catch((error) => {
            if (error instanceof StorageError && error.code === "storage") {
              return ingestOnce()
            }
            return Effect.fail(error)
          }),
          Effect.mapError((error) => {
            if (error instanceof StorageError && error.code !== "storage") {
              return new StorageError({ code: "invalid", message: "Webhook delivery is not usable" })
            }
            return error
          }),
          Effect.catch((error) => {
            if (error instanceof StorageError && error.code === "invalid") {
              return Effect.succeed(null)
            }
            return Effect.fail(error)
          }),
        )
        if (accepted === null) {
          return { status: 401, accepted: false } as const
        }
        for (const jobId of accepted.jobIds) allJobIds.push(jobId)
        for (const runId of accepted.runIds) allRunIds.push(runId)
      }
      if (!matchedAny) {
        return { status: 200, accepted: false } as const
      }
      return {
        status: 200,
        accepted: true,
        deliveryId: input.deliveryId,
        jobIds: allJobIds,
        runIds: allRunIds,
      } as const
    })

  return { handle }
}

const GithubWebhookRepository = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1)),
  owner: Schema.Struct({ login: Schema.String.check(Schema.isMinLength(1)) }),
})

const GithubWebhookIssue = Schema.Struct({
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  title: Schema.String.check(Schema.isMinLength(1)),
  body: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
})

const GithubWebhookIssuesEvent = Schema.Struct({
  action: Schema.String,
  repository: GithubWebhookRepository,
  issue: GithubWebhookIssue,
})

const JsonUnknown = Schema.fromJsonString(Schema.Unknown)

interface CandidateIntegration {
  readonly scope: PersonalScope
  readonly integration: IntegrationConfiguration
}

const findCandidateIntegrations = (
  services: GithubWebhookServices,
  owner: string,
  repo: string,
): Effect.Effect<ReadonlyArray<CandidateIntegration>, StorageError> =>
  Effect.gen(function* () {
    const rows = yield* services.sql<{ owner_id: string; project_id: string; id: string }>`
      SELECT owner_id, project_id, id FROM automation_integrations
      WHERE definition_id = ${githubIntegrationReference.id}
    `.pipe(
      Effect.mapError(() => new StorageError({ code: "storage", message: "Integration lookup failed" })),
    )
    const candidates: Array<CandidateIntegration> = []
    for (const row of rows) {
      const scopeOption = yield* Schema.decodeUnknownEffect(PersonalScope, { onExcessProperty: "error" })({
        ownerId: row.owner_id,
        projectId: row.project_id,
      }).pipe(Effect.option)
      if (scopeOption._tag === "None") continue
      const scope = scopeOption.value
      const stored = yield* services.configurations.getIntegration(scope, row.id)
      if (stored === null) continue
      const repository = yield* Schema.decodeUnknownEffect(GithubRepositoryConfiguration, {
        onExcessProperty: "error",
      })(stored.configuration.configuration).pipe(Effect.option)
      if (repository._tag === "None") continue
      if (repository.value.owner.toLowerCase() !== owner.toLowerCase()) continue
      if (repository.value.repo.toLowerCase() !== repo.toLowerCase()) continue
      if (!sameDefinition(stored.configuration.definition, githubIntegrationReference)) continue
      candidates.push({ scope, integration: stored.configuration })
    }
    return candidates as ReadonlyArray<CandidateIntegration>
  })

const resolveWebhookSecret = (
  services: GithubWebhookServices,
  scope: PersonalScope,
  integration: IntegrationConfiguration,
): Effect.Effect<Uint8Array | null, StorageError> =>
  Effect.gen(function* () {
    const slot: unknown = integration.credentials[GithubWebhookCredentialSlot]
    if (slot === undefined) return null
    const reference = yield* Schema.decodeUnknownEffect(CredentialReference, {
      onExcessProperty: "error",
    })(slot).pipe(Effect.option)
    if (reference._tag === "None") return null
    const secret = yield* services.credentials.resolveSecret(scope, reference.value.credentialId)
    if (secret === null) return null
    if (!(secret instanceof Uint8Array) || secret.length === 0) return null
    const secretOption = yield* decodeWebhookSecret(secret).pipe(Effect.option)
    if (secretOption._tag === "None") return null
    return new Uint8Array(secret)
  })

const findMatchingRoutines = (
  services: GithubWebhookServices,
  scope: PersonalScope,
  integrationId: string,
): Effect.Effect<ReadonlyArray<{ reference: { routineId: string; revision: number }; integrations: ReadonlyArray<{ id: string }>; process: { actions: Record<string, ReadonlyArray<{ action: { id: string; version: number }; integration: { id: string } }>>; trigger: { definition: { id: string; version: number }; integration: { id: string; definition: { id: string; version: number } } } } }>, StorageError> =>
  Effect.gen(function* () {
    const heads = yield* services.configurations.listHeads(scope)
    const matching = []
    for (const head of heads) {
      if (head.head.status !== "enabled") continue
      const revision = yield* services.configurations.getRevision(scope, head.routineId, head.head.revision)
      if (revision === null) continue
      if (!sameDefinition(revision.process.trigger.definition, githubTriggerReference)) continue
      if (revision.process.trigger.integration.id !== integrationId) continue
      if (!sameDefinition(revision.process.trigger.integration.definition, githubIntegrationReference)) continue
      matching.push({
        reference: { ...revision.reference },
        integrations: revision.integrations.map((integration) => ({ id: integration.id })),
        process: {
          actions: Object.fromEntries(
            Object.entries(revision.process.actions).map(([outcome, steps]) => [
              outcome,
              steps.map((step) => ({
                action: { ...step.action },
                integration: { ...step.integration },
              })),
            ]),
          ),
          trigger: {
            definition: { ...revision.process.trigger.definition },
            integration: {
              id: revision.process.trigger.integration.id,
              definition: { ...revision.process.trigger.integration.definition },
            },
          },
        },
      })
    }
    return matching
  })
