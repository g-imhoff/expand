import { Context, Data, Effect, Layer, Result, Schema, SchemaIssue } from "effect"
import { createHmac, timingSafeEqual } from "node:crypto"
import {
  CredentialReference, PersonalScope, definitionKey, sameDefinition
} from "@expand/contracts/automation"
import type { ActionGrant, AutomationRun, DefinitionReference, IntegrationConfiguration, RoutineConfiguration } from "@expand/contracts/automation"
import { defineTrigger } from "@expand/contracts/automation"
import type { TriggerDefinition } from "@expand/contracts/automation"
import { ConfigurationRepository } from "./configuration-repository.js"
import { CredentialRepository } from "./credential-repository.js"
import { ExecutionRepository } from "./execution-repository.js"
import type { Delivery, StorageError } from "./persistence-models.js"
import { AutomationRegistryService } from "./registry.js"

export interface CustomWebhookInput {
  readonly raw: Uint8Array
  readonly ownerId: string | undefined
  readonly projectId: string | undefined
  readonly integrationId: string | undefined
  readonly deliveryId: string | undefined
  readonly signature: string | undefined
  readonly routineId?: string | undefined
}
export interface CustomWebhookResponse { readonly status: number; readonly body: unknown }
export interface PayloadIssue { readonly path: string; readonly message: string }
export class CustomWebhook extends Context.Service<CustomWebhook, {
  readonly handle: (input: CustomWebhookInput) => Effect.Effect<CustomWebhookResponse>
}>()("expand/CustomWebhook") {}
export type CustomTriggerDefinition = TriggerDefinition
export const defineCustomTrigger = defineTrigger
export const CustomWebhookSecretSlot = "webhookSecret"
export const CustomWebhookRoutePath = "/webhooks/custom"
export const verifyCustomSignature = (raw: Uint8Array, signature: string | undefined, secret: string): boolean => {
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
export const signCustomDelivery = (raw: Uint8Array, secret: string): string =>
  `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`
export const formatPayloadIssues = (issue: SchemaIssue.Issue): ReadonlyArray<PayloadIssue> => {
  const formatter = SchemaIssue.makeFormatterStandardSchemaV1()
  const failure = formatter(issue)
  return failure.issues.map((entry) => ({ path: formatIssuePath(entry.path), message: entry.message }))
}
export const CustomWebhookLayer: Layer.Layer<CustomWebhook, never, ConfigurationRepository | CredentialRepository | ExecutionRepository | AutomationRegistryService> =
  Layer.effect(CustomWebhook, Effect.gen(function*() {
    const configurations = yield* ConfigurationRepository
    const credentials = yield* CredentialRepository
    const executions = yield* ExecutionRepository
    const registry = yield* AutomationRegistryService
    const handle = (input: CustomWebhookInput): Effect.Effect<CustomWebhookResponse> =>
      processCustomDelivery(input, configurations, credentials, executions, registry).pipe(
        Effect.catch((error): Effect.Effect<CustomWebhookResponse> => {
          if (error._tag === "CustomWebhookFailure") {
            return Effect.succeed(error.status === 200
              ? { status: 200, body: { ok: true, deliveryId: error.deliveryId, ignored: error.reason } }
              : { status: error.status, body: error.status === 400 && error.issues !== undefined
                ? { ok: false, reason: error.reason, ...(error.routineId === undefined ? {} : { routineId: error.routineId }), errors: [...error.issues] }
                : { ok: false, reason: error.reason, ...(error.routineId === undefined ? {} : { routineId: error.routineId }) } })
          }
          return Effect.succeed(error.code === "conflict"
            ? { status: 409, body: { ok: false, reason: "delivery-conflict" } }
            : { status: 500, body: { ok: false, reason: "storage-unavailable" } })
        })
      )
    return CustomWebhook.of({ handle })
  }))

class CustomWebhookFailure extends Data.TaggedError("CustomWebhookFailure")<{
  readonly status: 200 | 400 | 401
  readonly reason: string
  readonly deliveryId: string | null
  readonly routineId?: string | undefined
  readonly issues?: ReadonlyArray<PayloadIssue> | undefined
}> {}
const textDecoder = new TextDecoder()
const processCustomDelivery = Effect.fn("CustomWebhook.processDelivery")(function*(
  input: CustomWebhookInput,
  configurations: ConfigurationRepository["Service"],
  credentials: CredentialRepository["Service"],
  executions: ExecutionRepository["Service"],
  registry: AutomationRegistryService["Service"]
): Effect.fn.Return<CustomWebhookResponse, CustomWebhookFailure | StorageError> {
  const deliveryId = input.deliveryId
  if (deliveryId === undefined || deliveryId.length === 0) return yield* new CustomWebhookFailure({ status: 400, reason: "missing-delivery", deliveryId: null })
  const integrationId = input.integrationId
  if (integrationId === undefined || integrationId.length === 0) return yield* new CustomWebhookFailure({ status: 400, reason: "missing-integration", deliveryId: null })
  if (input.ownerId === undefined || input.ownerId.length === 0 || input.projectId === undefined || input.projectId.length === 0) {
    return yield* new CustomWebhookFailure({ status: 400, reason: "missing-scope", deliveryId: null })
  }
  const scope = yield* Schema.decodeUnknownEffect(PersonalScope)({ ownerId: input.ownerId, projectId: input.projectId }).pipe(
    Effect.mapError(() => new CustomWebhookFailure({ status: 400, reason: "invalid-scope", deliveryId: null }))
  )
  yield* Schema.decodeUnknownEffect(Schema.String.check(Schema.isMinLength(1)))(integrationId).pipe(
    Effect.mapError(() => new CustomWebhookFailure({ status: 400, reason: "invalid-integration", deliveryId: null }))
  )
  if (input.routineId !== undefined && input.routineId.length === 0) {
    return yield* new CustomWebhookFailure({ status: 400, reason: "invalid-routine", deliveryId: null })
  }
  const json = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(textDecoder.decode(input.raw)).pipe(
    Effect.mapError(() => new CustomWebhookFailure({ status: 400, reason: "invalid-json", deliveryId: null }))
  )
  const payloadJson = yield* Schema.decodeUnknownEffect(Schema.Json)(json).pipe(
    Effect.mapError(() => new CustomWebhookFailure({ status: 400, reason: "invalid-json", deliveryId: null }))
  )
  const stored = yield* configurations.getIntegration(scope, integrationId)
  if (stored === null) return yield* new CustomWebhookFailure({ status: 200, reason: "unknown-integration", deliveryId })
  const integration = stored.configuration
  const secret = yield* webhookSecretFor(credentials, scope, integration)
  if (secret === null) return yield* new CustomWebhookFailure({ status: 401, reason: "missing-webhook-secret", deliveryId: null })
  if (!verifyCustomSignature(input.raw, input.signature, secret)) {
    return yield* new CustomWebhookFailure({ status: 401, reason: "invalid-signature", deliveryId: null })
  }
  const heads = yield* configurations.listHeads(scope)
  const matches: Array<{ routine: RoutineConfiguration }> = []
  for (const listed of heads) {
    if (listed.head.status !== "enabled") continue
    if (input.routineId !== undefined && listed.routineId !== input.routineId) continue
    const routine = yield* configurations.getRevision(scope, listed.routineId, listed.head.revision)
    if (routine === null) continue
    if (routine.process.trigger.integration.id !== integration.id) continue
    if (!sameDefinition(routine.process.trigger.integration.definition, integration.definition)) continue
    matches.push({ routine })
  }
  if (matches.length === 0) {
    return yield* new CustomWebhookFailure({ status: 200, reason: input.routineId === undefined ? "no-matching-routine" : "unknown-routine", deliveryId })
  }
  for (const match of matches) {
    const codec = registry.findTrigger(match.routine.process.trigger.definition)
    if (codec === null) return yield* new CustomWebhookFailure({ status: 200, reason: "unknown-trigger", deliveryId })
    const validated = yield* Effect.result(Schema.decodeUnknownEffect(codec.payloadSchema)(json))
    if (Result.isFailure(validated)) {
      const issues = formatPayloadIssues(validated.failure.issue)
      return yield* new CustomWebhookFailure({ status: 400, reason: "invalid-payload", deliveryId: null, routineId: match.routine.reference.routineId, issues })
    }
  }
  const groups = new Map<string, { trigger: DefinitionReference; routines: Array<RoutineConfiguration> }>()
  for (const match of matches) {
    const key = definitionKey(match.routine.process.trigger.definition)
    const group = groups.get(key)
    if (group === undefined) groups.set(key, { trigger: match.routine.process.trigger.definition, routines: [match.routine] })
    else group.routines.push(match.routine)
  }
  const ordered = [...groups.values()].sort((left, right) =>
    definitionKey(left.trigger).localeCompare(definitionKey(right.trigger)))
  const jobIds: Array<string> = []
  const runIds: Array<string> = []
  for (const group of ordered) {
    const triggerKey = `${group.trigger.id}@${group.trigger.version}`
    const storedId = ordered.length > 1 ? `${deliveryId}:${triggerKey}` : deliveryId
    const externalId = storedId
    const delivery: Delivery = {
      schemaVersion: 1, id: storedId, scope,
      integration: { id: integration.id, definition: integration.definition },
      externalId, trigger: group.trigger, payload: payloadJson
    }
    const targets = group.routines.map((routine) => ({
      jobId: `${storedId}:job:${routine.reference.routineId}`,
      run: buildCustomRun(scope, routine, `${storedId}:run:${routine.reference.routineId}`, storedId, registry)
    }))
    const accepted = yield* executions.ingest({ delivery, raw: input.raw, targets })
    jobIds.push(...accepted.jobIds)
    runIds.push(...accepted.runIds)
  }
  return { status: 200, body: { ok: true, deliveryId, jobIds, runIds } }
})
const webhookSecretFor = Effect.fn("CustomWebhook.webhookSecret")(function*(
  credentials: CredentialRepository["Service"], scope: PersonalScope, integration: IntegrationConfiguration
): Effect.fn.Return<string | null, StorageError> {
  const reference = integration.credentials[CustomWebhookSecretSlot]
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
function capabilitiesFor(registry: AutomationRegistryService["Service"], action: DefinitionReference): ReadonlyArray<string> {
  for (const entry of registry.catalog().definitions) {
    if (entry.kind === "action" && sameDefinition(entry.definition, action)) return [...entry.capabilities]
  }
  return []
}
function buildCustomRun(scope: PersonalScope, routine: RoutineConfiguration, runId: string, deliveryId: string, registry: AutomationRegistryService["Service"]): AutomationRun {
  const integrationIds = [...new Set(routine.integrations.map((entry) => entry.id))]
  const grants: Array<ActionGrant> = []
  const seen = new Set<string>()
  for (const steps of Object.values(routine.process.actions)) {
    for (const step of steps) {
      const key = `${step.integration.id} ${step.action.id}@${step.action.version}`
      if (seen.has(key)) continue
      seen.add(key)
      grants.push({ action: step.action, integrationId: step.integration.id, capabilities: [...capabilitiesFor(registry, step.action)] })
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
function formatIssuePath(path: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined): string {
  if (path === undefined || path.length === 0) return ""
  return path.map((segment) => typeof segment === "object" && segment !== null && "key" in segment ? String(segment.key) : String(segment)).join(".")
}
