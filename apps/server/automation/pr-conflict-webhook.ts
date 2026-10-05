import { createHmac, timingSafeEqual } from "node:crypto"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { CredentialReference, LocalId, PersonalScope, sameDefinition } from "@expand/contracts/automation"
import { GithubPrConflictPayload, conflictIntegrationReference, prConflictTriggerReference } from "@expand/contracts/automation/conflicts"
import { GithubRepositoryConfiguration } from "@expand/contracts/automation/github"
import { ConfigurationRepository } from "./configuration-repository.js"
import { CredentialRepository } from "./credential-repository.js"
import { ExecutionRepository } from "./execution-repository.js"
import { StorageError, encodeJson } from "./persistence-models.js"

export interface PrConflictWebhookServices {
  readonly configurations: ConfigurationRepository["Service"]
  readonly credentials: CredentialRepository["Service"]
  readonly executions: ExecutionRepository["Service"]
  readonly sql: SqlClient
}

export interface PrConflictWebhookInput {
  readonly deliveryId: string
  readonly event: string
  readonly signature: string | undefined
  readonly raw: Uint8Array
}

export type PrConflictWebhookOutcome =
  | { readonly status: 200; readonly accepted: false }
  | { readonly status: 200; readonly accepted: true; readonly deliveryId: string; readonly jobIds: ReadonlyArray<string>; readonly runIds: ReadonlyArray<string> }
  | { readonly status: 401; readonly accepted: false }

export const PrConflictWebhookCredentialSlot = "token"

export const verifyPrConflictSignature = (
  secret: Uint8Array,
  raw: Uint8Array,
  signatureHeader: string | undefined
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

export const decodePrConflictEvent = (value: unknown): Effect.Effect<typeof GithubPrConflictPayload.Type | null, never> =>
  Effect.gen(function*() {
    const parsed = yield* Schema.decodeUnknownEffect(PrWebhookPullEvent, { onExcessProperty: "ignore" })(value).pipe(Effect.option)
    if (parsed._tag === "None") return null
    const event = parsed.value
    if (event.action !== "opened" && event.action !== "synchronize" && event.action !== "reopened") return null
    const mergeable = event.pull_request.mergeable ?? null
    const state = typeof event.pull_request.mergeable_state === "string" ? event.pull_request.mergeable_state.toLowerCase() : ""
    const isConflicted = mergeable === false || state === "dirty"
    if (!isConflicted) return null
    const payload = {
      pullNumber: event.pull_request.number,
      headBranch: event.pull_request.head.ref,
      baseBranch: event.pull_request.base.ref,
      headSha: event.pull_request.head.sha,
      mergeable: false
    }
    const proved = yield* Schema.decodeUnknownEffect(GithubPrConflictPayload, { onExcessProperty: "error" })(payload).pipe(Effect.option)
    if (proved._tag === "None") return null
    return proved.value
  })

export const makePrConflictWebhookHandler = (services: PrConflictWebhookServices) => {
  const handle = (input: PrConflictWebhookInput): Effect.Effect<PrConflictWebhookOutcome, StorageError> =>
    Effect.gen(function*() {
      if (typeof input.deliveryId !== "string" || input.deliveryId.length === 0) return { status: 401, accepted: false } as const
      if (input.event !== "pull_request") return { status: 200, accepted: false } as const
      if (!(input.raw instanceof Uint8Array)) return { status: 401, accepted: false } as const
      const textOption = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(input.raw),
        catch: () => new StorageError({ code: "invalid", message: "Webhook body is not usable" })
      }).pipe(Effect.option)
      if (textOption._tag === "None") return { status: 401, accepted: false } as const
      const unknownOption = yield* Schema.decodeUnknownEffect(JsonUnknown, { onExcessProperty: "ignore" })(textOption.value).pipe(Effect.option)
      if (unknownOption._tag === "None") return { status: 401, accepted: false } as const
      const payload = yield* decodePrConflictEvent(unknownOption.value)
      if (payload === null) return { status: 200, accepted: false } as const
      const deliveryOption = yield* Schema.decodeUnknownEffect(LocalId, { onExcessProperty: "error" })(input.deliveryId).pipe(Effect.option)
      if (deliveryOption._tag === "None") return { status: 401, accepted: false } as const
      const candidates = yield* findCandidateIntegrations(services)
      if (candidates.length === 0) return { status: 200, accepted: false } as const
      const verified = []
      for (const candidate of candidates) {
        const secret = yield* resolveWebhookSecret(services, candidate.scope, candidate.integration)
        if (secret === null) continue
        if (verifyPrConflictSignature(secret, input.raw, input.signature)) verified.push(candidate)
      }
      if (verified.length === 0) return { status: 401, accepted: false } as const
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
          trigger: { ...prConflictTriggerReference },
          payload: { ...payload }
        }
        const targets = routines.map((routine) => {
          const routineId = routine.reference.routineId
          const revision = routine.reference.revision
          const jobId = `${storedDeliveryId}:${routineId}:job`
          const runId = `${storedDeliveryId}:${routineId}:run`
          return {
            jobId,
            run: {
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
                integrationIds: routine.integrations.map((integration) => integration.id),
                actionGrants: routine.actionGrants.map((grant) => ({ action: { ...grant.action }, integrationId: grant.integrationId, capabilities: [...grant.capabilities] }))
              },
              state: { kind: "queued" as const },
              actions: []
            }
          }
        })
        const ingestOnce = () => services.executions.ingest({ delivery, raw: input.raw, targets })
        const accepted = yield* ingestOnce().pipe(
          Effect.catch((error) => {
            if (error instanceof StorageError && error.code === "storage") return ingestOnce()
            return Effect.fail(error)
          }),
          Effect.mapError((error) => {
            if (error instanceof StorageError && error.code !== "storage") return new StorageError({ code: "invalid", message: "Webhook delivery is not usable" })
            return error
          }),
          Effect.catch((error) => {
            if (error instanceof StorageError && error.code === "invalid") return Effect.succeed(null)
            return Effect.fail(error)
          })
        )
        if (accepted === null) return { status: 401, accepted: false } as const
        for (const jobId of accepted.jobIds) allJobIds.push(jobId)
        for (const runId of accepted.runIds) allRunIds.push(runId)
      }
      if (!matchedAny) return { status: 200, accepted: false } as const
      return { status: 200, accepted: true, deliveryId: input.deliveryId, jobIds: allJobIds, runIds: allRunIds } as const
    })
  return { handle }
}

const PrWebhookBranch = Schema.Struct({ ref: Schema.String.check(Schema.isMinLength(1)), sha: Schema.String.check(Schema.isMinLength(1)) })
const PrWebhookPull = Schema.Struct({
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  head: PrWebhookBranch,
  base: PrWebhookBranch,
  mergeable: Schema.optional(Schema.Union([Schema.Boolean, Schema.Null])),
  mergeable_state: Schema.optional(Schema.Union([Schema.String, Schema.Null]))
})
const PrWebhookPullEvent = Schema.Struct({ action: Schema.String, pull_request: PrWebhookPull })
const JsonUnknown = Schema.fromJsonString(Schema.Unknown)

interface CandidateIntegration {
  readonly scope: PersonalScope
  readonly integration: { readonly id: string; readonly definition: { readonly id: string; readonly version: number }; readonly configuration: Record<string, unknown>; readonly credentials: Record<string, unknown> }
}

const findCandidateIntegrations = (services: PrConflictWebhookServices): Effect.Effect<ReadonlyArray<CandidateIntegration>, StorageError> =>
  Effect.gen(function*() {
    const rows = yield* services.sql<{ owner_id: string; project_id: string; id: string }>`
      SELECT owner_id, project_id, id FROM automation_integrations
      WHERE definition_id = ${conflictIntegrationReference.id}
    `.pipe(Effect.mapError(() => new StorageError({ code: "storage", message: "Integration lookup failed" })))
    const candidates: Array<CandidateIntegration> = []
    for (const row of rows) {
      const scopeOption = yield* Schema.decodeUnknownEffect(PersonalScope, { onExcessProperty: "error" })({ ownerId: row.owner_id, projectId: row.project_id }).pipe(Effect.option)
      if (scopeOption._tag === "None") continue
      const stored = yield* services.configurations.getIntegration(scopeOption.value, row.id)
      if (stored === null) continue
      if (!sameDefinition(stored.configuration.definition, conflictIntegrationReference)) continue
      candidates.push({ scope: scopeOption.value, integration: { id: stored.configuration.id, definition: { ...stored.configuration.definition }, configuration: { ...(stored.configuration.configuration as Record<string, unknown>) }, credentials: { ...(stored.configuration.credentials as Record<string, unknown>) } } })
    }
    return candidates as ReadonlyArray<CandidateIntegration>
  })

const resolveWebhookSecret = (
  services: PrConflictWebhookServices,
  scope: PersonalScope,
  integration: CandidateIntegration["integration"]
): Effect.Effect<Uint8Array | null, StorageError> =>
  Effect.gen(function*() {
    const slot: unknown = integration.credentials[PrConflictWebhookCredentialSlot]
    if (slot === undefined) return null
    const reference = yield* Schema.decodeUnknownEffect(CredentialReference, { onExcessProperty: "error" })(slot).pipe(Effect.option)
    if (reference._tag === "None") return null
    const secret = yield* services.credentials.resolveSecret(scope, reference.value.credentialId)
    if (secret === null || !(secret instanceof Uint8Array) || secret.length === 0) return null
    return new Uint8Array(secret)
  })

const findMatchingRoutines = (
  services: PrConflictWebhookServices,
  scope: PersonalScope,
  integrationId: string
): Effect.Effect<ReadonlyArray<{ reference: { routineId: string; revision: number }; integrations: ReadonlyArray<{ id: string }>; actionGrants: ReadonlyArray<{ action: { id: string; version: number }; integrationId: string; capabilities: ReadonlyArray<string> }> }>, StorageError> =>
  Effect.gen(function*() {
    const heads = yield* services.configurations.listHeads(scope)
    const matching = []
    for (const head of heads) {
      if (head.head.status !== "enabled") continue
      const revision = yield* services.configurations.getRevision(scope, head.routineId, head.head.revision)
      if (revision === null) continue
      if (!sameDefinition(revision.process.trigger.definition, prConflictTriggerReference)) continue
      if (revision.process.trigger.integration.id !== integrationId) continue
      const grants = []
      for (const steps of Object.values(revision.process.actions)) {
        for (const step of steps) {
          grants.push({ action: { ...step.action }, integrationId: step.integration.id, capabilities: ["resolve"] })
        }
      }
      matching.push({ reference: { ...revision.reference }, integrations: revision.integrations.map((integration) => ({ id: integration.id })), actionGrants: grants })
    }
    return matching
  })
