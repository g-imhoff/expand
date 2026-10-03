import { Effect, Result, Schema } from "effect"
import { AutomationError, PersonalScope, decodeJson, sameDefinition } from "@expand/contracts/automation"
import type { ActionGrant, AutomationRun, DefinitionReference, RoutineConfiguration } from "@expand/contracts/automation"
import type { ContextFreeCodec } from "@expand/contracts/automation"
import { ExecutionRepository } from "./execution-repository.js"
import { RoutineService } from "./routine-service.js"
import { AutomationRegistry } from "./registry.js"
import { StorageError, encodeJson } from "./persistence-models.js"
import type { Delivery } from "./persistence-models.js"
import { formatPayloadIssues } from "./custom-webhook.js"

export interface ManualPreviewInput {
  readonly scope: PersonalScope
  readonly routineId: string
  readonly payload: unknown
  readonly decision?: unknown
}
export interface ManualStartInput extends ManualPreviewInput {
  readonly deliveryId: string
  readonly mode?: "preview" | "live" | undefined
}
export interface ManualPreviewSelected {
  readonly kind: "selected"
  readonly outcomeId: string
  readonly actions: ReadonlyArray<{ readonly stepId: string; readonly arguments: Schema.Json }>
}
export interface ManualPreviewUnresolved { readonly kind: "unresolved"; readonly reason: string }
export interface ManualPreviewResult {
  readonly routineId: string
  readonly revision: number
  readonly preview: ManualPreview
}
export interface ManualStartResult {
  readonly deliveryId: string
  readonly jobIds: ReadonlyArray<string>
  readonly runIds: ReadonlyArray<string>
}
export type ManualPreview = ManualPreviewSelected | ManualPreviewUnresolved
export const previewManual = Effect.fn("ManualTrigger.preview")(function*<R>(
  input: ManualPreviewInput,
  deps: { readonly routines: RoutineService["Service"]; readonly registry: AutomationRegistry<R> }
): Effect.fn.Return<ManualPreviewResult, AutomationError | StorageError> {
  const scope = yield* decodeScope(input.scope)
  const routineId = yield* decodeLocalId(input.routineId, "routineId")
  const routine = yield* deps.routines.get(scope, routineId)
  if (routine === null) return yield* new StorageError({ code: "missing", message: "Routine does not exist" })
  const codec = deps.registry.findTrigger(routine.configuration.process.trigger.definition)
  if (codec === null) return yield* new AutomationError({ code: "missing-definition", message: "Trigger is not registered" })
  yield* assertPayload(codec.payloadSchema, input.payload, routineId)
  const resolved = yield* deps.registry.resolveSelectedActions(routine.configuration, input.payload, input.decision)
  if (resolved.selection.kind === "selected") {
    return {
      routineId, revision: routine.configuration.reference.revision,
      preview: { kind: "selected", outcomeId: resolved.selection.outcomeId, actions: resolved.actions.map((action) => ({ stepId: action.stepId, arguments: action.arguments })) }
    }
  }
  return { routineId, revision: routine.configuration.reference.revision, preview: { kind: "unresolved", reason: resolved.selection.reason } }
})
export const startManual = Effect.fn("ManualTrigger.start")(function*<R>(
  input: ManualStartInput,
  deps: { readonly routines: RoutineService["Service"]; readonly executions: ExecutionRepository["Service"]; readonly registry: AutomationRegistry<R> }
): Effect.fn.Return<ManualStartResult, AutomationError | StorageError> {
  const scope = yield* decodeScope(input.scope)
  const routineId = yield* decodeLocalId(input.routineId, "routineId")
  const deliveryId = yield* decodeLocalId(input.deliveryId, "deliveryId")
  const mode = input.mode ?? "live"
  if (mode !== "live" && mode !== "preview") return yield* new AutomationError({ code: "invalid-contract", message: "mode must be preview or live" })
  const routine = yield* deps.routines.assertDue(scope, routineId)
  const codec = deps.registry.findTrigger(routine.configuration.process.trigger.definition)
  if (codec === null) return yield* new AutomationError({ code: "missing-definition", message: "Trigger is not registered" })
  yield* assertPayload(codec.payloadSchema, input.payload, routineId)
  const resolved = yield* Effect.result(deps.registry.resolveSelectedActions(routine.configuration, input.payload, input.decision))
  if (Result.isFailure(resolved)) return yield* resolved.failure
  const payloadJson = yield* decodeJson(Schema.Json, input.payload).pipe(
    Effect.mapError(() => new AutomationError({ code: "invalid-contract", message: "Trigger payload must be encoded JSON" }))
  )
  const trigger = routine.configuration.process.trigger
  const delivery: Delivery = {
    schemaVersion: 1, id: deliveryId, scope,
    integration: { id: trigger.integration.id, definition: trigger.integration.definition },
    externalId: deliveryId, trigger: trigger.definition, payload: payloadJson
  }
  const run = buildManualRun(scope, routine.configuration, deliveryId, mode, deps.registry)
  const accepted = yield* deps.executions.ingest({ delivery, raw: new TextEncoder().encode(encodeJson(payloadJson)), targets: [{ jobId: `${deliveryId}:job:${routineId}`, run }] })
  return { deliveryId, jobIds: [...accepted.jobIds], runIds: [...accepted.runIds] }
})
const decodeScope = (scope: unknown): Effect.Effect<PersonalScope, AutomationError> =>
  decodeJson(PersonalScope, scope).pipe(
    Effect.mapError(() => new AutomationError({ code: "invalid-contract", message: "scope.ownerId is required and scope.projectId is required" }))
  )
const decodeLocalId = (value: unknown, field: string): Effect.Effect<string, AutomationError> =>
  decodeJson(Schema.String.check(Schema.isMinLength(1)), value).pipe(
    Effect.mapError(() => new AutomationError({ code: "invalid-contract", message: `${field} must be a non-empty string` }))
  )
const assertPayload = Effect.fn("ManualTrigger.assertPayload")(function*(
  codec: ContextFreeCodec, payload: unknown, routineId: string
): Effect.fn.Return<void, AutomationError> {
  const validated = yield* Effect.result(Schema.decodeUnknownEffect(codec)(payload))
  if (Result.isFailure(validated)) {
    const issues = formatPayloadIssues(validated.failure.issue)
    const detail = issues.length === 0 ? "payload does not match the trigger schema"
      : issues.map((entry) => entry.path.length === 0 ? entry.message : `${entry.path}: ${entry.message}`).join("; ")
    return yield* new AutomationError({ code: "invalid-contract", message: `Invalid trigger payload for routine ${routineId}: ${detail}` })
  }
})
function capabilitiesFor<R>(registry: AutomationRegistry<R>, action: DefinitionReference): ReadonlyArray<string> {
  for (const entry of registry.catalog().definitions) {
    if (entry.kind === "action" && sameDefinition(entry.definition, action)) return [...entry.capabilities]
  }
  return []
}
function buildManualRun<R>(
  scope: PersonalScope, configuration: RoutineConfiguration, deliveryId: string, mode: "preview" | "live", registry: AutomationRegistry<R>
): AutomationRun {
  const integrationIds = [...new Set(configuration.integrations.map((entry) => entry.id))]
  const grants: Array<ActionGrant> = []
  const seen = new Set<string>()
  for (const steps of Object.values(configuration.process.actions)) {
    for (const step of steps) {
      const key = `${step.integration.id} ${step.action.id}@${step.action.version}`
      if (seen.has(key)) continue
      seen.add(key)
      grants.push({ action: step.action, integrationId: step.integration.id, capabilities: [...capabilitiesFor(registry, step.action)] })
    }
  }
  return {
    schemaVersion: 1, kind: "run", id: `${deliveryId}:run:${configuration.reference.routineId}`, scope,
    configuration: configuration.reference,
    input: { kind: "input-reference", id: deliveryId },
    mode,
    authority: { schemaVersion: 1, kind: "invocation-authority", scope, configuration: configuration.reference, integrationIds, actionGrants: grants },
    state: { kind: "queued" },
    actions: []
  }
}
