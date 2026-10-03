import { Context, Data, Effect, Layer, Schema } from "effect"
import { createHmac, timingSafeEqual } from "node:crypto"
import {
  CredentialReference, GithubIssuePayload, IntegrationConfiguration, PersonalScope,
  RoutineConfiguration, githubIntegrationReference, githubLabelActionReference, githubTriggerReference, sameDefinition
} from "@expand/contracts/automation"
import type { ActionGrant, AutomationRun, DefinitionReference } from "@expand/contracts/automation"
import { ConfigurationRepository } from "./configuration-repository.js"
import { CredentialRepository } from "./credential-repository.js"
import { ExecutionRepository } from "./execution-repository.js"
import type { Delivery, StorageError } from "./persistence-models.js"

export interface GithubWebhookAllowedRepository { readonly owner: string; readonly repo: string }
export interface GithubWebhookOptions { readonly allowedRepos?: ReadonlyArray<GithubWebhookAllowedRepository> }
export interface GithubWebhookInput { readonly raw: Uint8Array; readonly event: string | undefined; readonly deliveryId: string | undefined; readonly signature: string | undefined }
export interface GithubWebhookResponse { readonly status: number; readonly body: unknown }
export class GithubWebhook extends Context.Service<GithubWebhook, {
  readonly handle: (input: GithubWebhookInput) => Effect.Effect<GithubWebhookResponse>
}>()("expand/GithubWebhook") {}
export const GithubWebhookSecretSlot = "webhookSecret"
export const GithubWebhookRoutePath = "/webhooks/github"
export const verifyGithubSignature = (raw: Uint8Array, signature: string | undefined, secret: string): boolean => {
  if (signature === undefined || secret.length === 0) return false
  if (!signature.startsWith("sha256=")) return false
  const presented = signature.slice("sha256=".length)
  if (presented.length === 0) return false
  let expected: string
  try {
    expected = createHmac("sha256", secret).update(raw).digest("hex")
  } catch {
    return false
  }
  if (presented.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(presented), Buffer.from(expected))
}
export const signGithubDelivery = (raw: Uint8Array, secret: string): string =>
  `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`
export const GithubWebhookLayer = (options?: GithubWebhookOptions): Layer.Layer<GithubWebhook, never, ConfigurationRepository | CredentialRepository | ExecutionRepository> =>
  Layer.effect(GithubWebhook, Effect.gen(function*() {
    const configurations = yield* ConfigurationRepository
    const credentials = yield* CredentialRepository
    const executions = yield* ExecutionRepository
    const allowed = options?.allowedRepos
    const handle = (input: GithubWebhookInput): Effect.Effect<GithubWebhookResponse> =>
      processDelivery(input, allowed, configurations, credentials, executions).pipe(
        Effect.catch((error): Effect.Effect<GithubWebhookResponse> => {
          if (error._tag === "GithubWebhookFailure") {
            return Effect.succeed(error.status === 200
              ? { status: 200, body: { ok: true, deliveryId: error.deliveryId, ignored: error.reason } }
              : { status: error.status, body: { ok: false, reason: error.reason } })
          }
          return Effect.succeed(error.code === "conflict"
            ? { status: 409, body: { ok: false, reason: "delivery-conflict" } }
            : { status: 500, body: { ok: false, reason: "storage-unavailable" } })
        })
      )
    return GithubWebhook.of({ handle })
  }))

class WebhookFailure extends Data.TaggedError("GithubWebhookFailure")<{
  readonly status: 200 | 400 | 401
  readonly reason: string
  readonly deliveryId: string | null
}> {}
const GithubWebhookIssue = Schema.Struct({
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  title: Schema.String.check(Schema.isMinLength(1)),
  body: Schema.optional(Schema.Union([Schema.String, Schema.Null]))
})
const GithubWebhookRepositoryShape = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1)),
  owner: Schema.Struct({ login: Schema.String.check(Schema.isMinLength(1)) })
})
const GithubWebhookIssuesEvent = Schema.Struct({
  action: Schema.Literal("opened"),
  issue: GithubWebhookIssue,
  repository: GithubWebhookRepositoryShape
})
const GithubWebhookAction = Schema.Struct({ action: Schema.String.check(Schema.isMinLength(1)) })
const textDecoder = new TextDecoder()
const processDelivery = Effect.fn("GithubWebhook.processDelivery")(function*(
  input: GithubWebhookInput,
  allowed: ReadonlyArray<GithubWebhookAllowedRepository> | undefined,
  configurations: ConfigurationRepository["Service"],
  credentials: CredentialRepository["Service"],
  executions: ExecutionRepository["Service"]
): Effect.fn.Return<GithubWebhookResponse, WebhookFailure | StorageError> {
  const deliveryId = input.deliveryId
  if (deliveryId === undefined || deliveryId.length === 0) return yield* new WebhookFailure({ status: 400, reason: "missing-delivery", deliveryId: null })
  const event = input.event
  if (event === undefined || event.length === 0) return yield* new WebhookFailure({ status: 400, reason: "missing-event", deliveryId: null })
  const json = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(textDecoder.decode(input.raw)).pipe(
    Effect.mapError(() => new WebhookFailure({ status: 400, reason: "invalid-json", deliveryId: null }))
  )
  if (event !== "issues") return yield* new WebhookFailure({ status: 200, reason: "unsupported-event", deliveryId })
  const action = yield* Schema.decodeUnknownEffect(GithubWebhookAction)(json).pipe(
    Effect.mapError(() => new WebhookFailure({ status: 400, reason: "invalid-event", deliveryId: null }))
  )
  if (action.action !== "opened") return yield* new WebhookFailure({ status: 200, reason: "unsupported-action", deliveryId })
  const opened = yield* Schema.decodeUnknownEffect(GithubWebhookIssuesEvent)(json).pipe(
    Effect.mapError(() => new WebhookFailure({ status: 400, reason: "invalid-event", deliveryId: null }))
  )
  const owner = opened.repository.owner.login
  const repo = opened.repository.name
  if (allowed !== undefined && !allowed.some((entry) => entry.owner === owner && entry.repo === repo)) {
    return yield* new WebhookFailure({ status: 200, reason: "unknown-repo", deliveryId })
  }
  const candidates = yield* configurations.listMatchingGithubIntegrations(owner, repo)
  if (candidates.length === 0) return yield* new WebhookFailure({ status: 200, reason: "unknown-repo", deliveryId })
  const verified: Array<{ scope: PersonalScope; integration: IntegrationConfiguration }> = []
  let secretConfigured = false
  for (const candidate of candidates) {
    const secret = yield* webhookSecretFor(credentials, candidate.scope, candidate.integration)
    if (secret === null) continue
    secretConfigured = true
    if (verifyGithubSignature(input.raw, input.signature, secret)) verified.push(candidate)
  }
  if (verified.length === 0) {
    return yield* new WebhookFailure({ status: 401, reason: secretConfigured ? "invalid-signature" : "missing-webhook-secret", deliveryId: null })
  }
  const matches: Array<{ scope: PersonalScope; integration: IntegrationConfiguration; routine: RoutineConfiguration }> = []
  for (const candidate of verified) {
    const heads = yield* configurations.listHeads(candidate.scope)
    for (const listed of heads) {
      if (listed.head.status !== "enabled") continue
      const routine = yield* configurations.getRevision(candidate.scope, listed.routineId, listed.head.revision)
      if (routine === null) continue
      if (!sameDefinition(routine.process.trigger.definition, githubTriggerReference)) continue
      if (routine.process.trigger.integration.id !== candidate.integration.id) continue
      if (!sameDefinition(routine.process.trigger.integration.definition, githubIntegrationReference)) continue
      matches.push({ scope: candidate.scope, integration: candidate.integration, routine })
    }
  }
  if (matches.length === 0) return yield* new WebhookFailure({ status: 200, reason: "no-matching-routine", deliveryId })
  const payloadJson: Schema.Json = opened.issue.body === undefined || opened.issue.body === null
    ? { issueNumber: opened.issue.number, title: opened.issue.title }
    : { issueNumber: opened.issue.number, title: opened.issue.title, body: opened.issue.body }
  yield* Schema.decodeUnknownEffect(GithubIssuePayload)(payloadJson).pipe(
    Effect.mapError(() => new WebhookFailure({ status: 400, reason: "invalid-event", deliveryId: null }))
  )
  const groups = new Map<string, { scope: PersonalScope; integration: IntegrationConfiguration; routines: Array<RoutineConfiguration> }>()
  for (const match of matches) {
    const key = `${match.scope.ownerId} ${match.scope.projectId} ${match.integration.id}`
    const group = groups.get(key)
    if (group === undefined) groups.set(key, { scope: match.scope, integration: match.integration, routines: [match.routine] })
    else group.routines.push(match.routine)
  }
  const scopeCounts = new Map<string, number>()
  for (const group of groups.values()) {
    const scopeKey = `${group.scope.ownerId} ${group.scope.projectId}`
    scopeCounts.set(scopeKey, (scopeCounts.get(scopeKey) ?? 0) + 1)
  }
  const ordered = [...groups.values()].sort((left, right) =>
    left.scope.ownerId.localeCompare(right.scope.ownerId) || left.scope.projectId.localeCompare(right.scope.projectId) || left.integration.id.localeCompare(right.integration.id))
  const jobIds: Array<string> = []
  const runIds: Array<string> = []
  for (const group of ordered) {
    const shared = (scopeCounts.get(`${group.scope.ownerId} ${group.scope.projectId}`) ?? 0) > 1
    const storedId = shared ? `${deliveryId}:${group.integration.id}` : deliveryId
    const delivery: Delivery = {
      schemaVersion: 1, id: storedId, scope: group.scope,
      integration: { id: group.integration.id, definition: githubIntegrationReference },
      externalId: deliveryId, trigger: githubTriggerReference, payload: payloadJson
    }
    const targets = group.routines.map((routine) => ({
      jobId: `${storedId}:job:${routine.reference.routineId}`,
      run: buildWebhookRun(group.scope, routine, `${storedId}:run:${routine.reference.routineId}`, storedId)
    }))
    const accepted = yield* executions.ingest({ delivery, raw: input.raw, targets })
    jobIds.push(...accepted.jobIds)
    runIds.push(...accepted.runIds)
  }
  return { status: 200, body: { ok: true, deliveryId, jobIds, runIds } }
})
const webhookSecretFor = Effect.fn("GithubWebhook.webhookSecret")(function*(
  credentials: CredentialRepository["Service"], scope: PersonalScope, integration: IntegrationConfiguration
): Effect.fn.Return<string | null, StorageError> {
  const reference = integration.credentials[GithubWebhookSecretSlot]
  if (reference === undefined) return null
  const proved = yield* Schema.decodeUnknownEffect(CredentialReference)(reference).pipe(
    Effect.catch(() => Effect.succeed(null))
  )
  if (proved === null) return null
  const secret = yield* credentials.resolveSecret(scope, proved.credentialId).pipe(
    Effect.catch((error) => error.code === "missing" ? Effect.succeed(null) : Effect.fail(error))
  )
  if (typeof secret !== "string" || secret.length === 0) return null
  return secret
})
function webhookCapabilitiesFor(action: DefinitionReference): ReadonlyArray<string> {
  return sameDefinition(action, githubLabelActionReference) ? ["label"] : []
}
function buildWebhookRun(scope: PersonalScope, routine: RoutineConfiguration, runId: string, deliveryId: string): AutomationRun {
  const integrationIds = [...new Set(routine.integrations.map((entry) => entry.id))]
  const grants: Array<ActionGrant> = []
  const seen = new Set<string>()
  for (const steps of Object.values(routine.process.actions)) {
    for (const step of steps) {
      const key = `${step.integration.id} ${step.action.id}@${step.action.version}`
      if (seen.has(key)) continue
      seen.add(key)
      grants.push({ action: step.action, integrationId: step.integration.id, capabilities: [...webhookCapabilitiesFor(step.action)] })
    }
  }
  return {
    schemaVersion: 1, kind: "run", id: runId, scope,
    configuration: routine.reference,
    input: { kind: "input-reference", id: deliveryId },
    mode: "live",
    authority: { schemaVersion: 1, kind: "invocation-authority", scope, configuration: routine.reference, integrationIds, actionGrants: grants },
    state: { kind: "queued" },
    actions: []
  }
}
