import { isSqlError } from "effect/sql/SqlError"
import { Data, Effect, Schema } from "effect"
import { ActionOutcome, AutomationFailure, AutomationRun, ConfigurationReference, decodeJson, DefinitionReference, IntegrationReference, JevDecisionRequest, JevDecisionResult, JsonValue, LocalId, PersonalScope, PositiveVersion, RoutineConfiguration, RunState, sameDefinition, validateProcess } from "@expand/contracts/automation"

export class StorageError extends Data.TaggedError("AutomationStorageError")<{
  readonly code: "invalid" | "conflict" | "missing" | "storage"
  readonly message: string
}> {}

export const Delivery = Schema.Struct({ schemaVersion: Schema.Literal(1), id: LocalId, scope: PersonalScope, integration: IntegrationReference, externalId: LocalId, trigger: DefinitionReference, payload: JsonValue })
export type Delivery = typeof Delivery.Type
export const Job = Schema.Struct({ id: LocalId, scope: PersonalScope, runId: LocalId, configuration: ConfigurationReference, inputId: LocalId, mode: Schema.Literals(["preview", "live"]), state: RunState, metadata: JsonValue })
export type Job = typeof Job.Type
export const Attempt = Schema.Union([
  Schema.Struct({ ...attemptBase(), kind: Schema.Literal("job"), status: Schema.Literal("started"), request: JsonValue }),
  Schema.Struct({ ...attemptBase(), kind: Schema.Literal("job"), status: Schema.Literal("completed"), request: JsonValue, completion: completionSchema() }),
  Schema.Struct({ ...attemptBase(), kind: Schema.Literal("decision"), status: Schema.Literal("started"), request: JevDecisionRequest }),
  Schema.Struct({ ...attemptBase(), kind: Schema.Literal("decision"), status: Schema.Literal("completed"), request: JevDecisionRequest, finishedAt: LocalId, result: Schema.optional(JevDecisionResult), error: Schema.optional(AutomationFailure) }),
  Schema.Struct({ ...attemptBase(), kind: Schema.Literal("action"), status: Schema.Literal("started"), integration: IntegrationReference, action: DefinitionReference, arguments: JsonValue }),
  Schema.Struct({ ...attemptBase(), kind: Schema.Literal("action"), status: Schema.Literal("completed"), integration: IntegrationReference, action: DefinitionReference, arguments: JsonValue, finishedAt: LocalId, outcome: ActionOutcome })
])
export type Attempt = typeof Attempt.Type
export const RoutineStatus = Schema.Literals(["enabled", "paused", "deleted"])
export type RoutineStatus = typeof RoutineStatus.Type
export const decode = <S extends Schema.ConstraintCodec<unknown, unknown, never, never>>(schema: S, input: unknown): Effect.Effect<S["Type"], StorageError> =>
  decodeJson(schema, input).pipe(Effect.mapError(() => new StorageError({ code: "invalid", message: "Invalid persistence value" })))
export const readJson = <S extends Schema.ConstraintCodec<unknown, unknown, never, never>>(schema: S, json: string) => Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(json).pipe(Effect.mapError(() => new StorageError({ code: "invalid", message: "Invalid stored JSON" })), Effect.flatMap((value) => decode(schema, value)))
export const guard = (condition: boolean, code: StorageError["code"] = "invalid"): Effect.Effect<void, StorageError> => condition ? Effect.void : Effect.fail(new StorageError({ code, message: "Persistence invariant rejected" }))
export const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
export const same = (left: unknown, right: unknown): boolean => deepEqual(left, right)
export const canonical = (input: unknown): string => encodeJson(sortKeys(input))
export const protectStorage = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(
  Effect.mapError((error) => error instanceof StorageError ? error : storageFailure()),
  Effect.catchDefect((defect) => isSqlError(defect) ? Effect.fail(storageFailure()) : Effect.die(defect))
)

export const validateConfiguration = Effect.fn("Persistence.validateConfiguration")(function*(input: unknown) {
  const config = yield* decode(RoutineConfiguration, input)
  yield* validateProcess(config.process).pipe(Effect.mapError(() => new StorageError({ code: "invalid", message: "Invalid process" })))
  yield* guard(new Set(config.integrations.map((value) => value.id)).size === config.integrations.length)
  for (const reference of [config.process.trigger.integration, ...Object.values(config.process.actions).flat().map((step) => step.integration)]) {
    yield* guard(config.integrations.some((value) => value.id === reference.id && sameDefinition(value.definition, reference.definition)))
  }
  return config
})
export const validateRun = Effect.fn("Persistence.validateRun")(function*(input: unknown, delivery: Delivery, configuration?: RoutineConfiguration) {
  const run = yield* decode(AutomationRun, input)
  yield* guard(same(run.scope, delivery.scope) && run.input.id === delivery.id && same(run.authority.scope, run.scope) && same(run.authority.configuration, run.configuration))
  if (configuration) {
    yield* guard(same(run.scope, configuration.scope) && same(run.configuration, configuration.reference))
    yield* guard(same(delivery.trigger, configuration.process.trigger.definition) && same(delivery.integration, configuration.process.trigger.integration))
    const ids = configuration.integrations.map((value) => value.id)
    yield* guard(run.authority.integrationIds.every((id) => ids.includes(id)))
    const steps = Object.values(configuration.process.actions).flat()
    for (const grant of run.authority.actionGrants) yield* guard(steps.some((step) => step.integration.id === grant.integrationId && sameDefinition(step.action, grant.action)) && run.authority.integrationIds.includes(grant.integrationId))
    for (const action of run.actions) yield* guard(steps.some((step) => step.id === action.stepId && sameDefinition(step.action, action.action)))
    if (run.decision) yield* guard(configuration.process.decision !== undefined && (run.decision.kind === "abstained" || configuration.process.decision.outcomes.includes(run.decision.outcomeId)))
  }
  return run
})

function storageFailure() { return new StorageError({ code: "storage", message: "Storage operation failed; commit outcome may be unknown" }) }
function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (typeof left !== typeof right || left === null || right === null || typeof left !== "object") return false
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, index) => deepEqual(value, right[index]))
  }
  if (left instanceof Uint8Array || right instanceof Uint8Array) {
    if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array) || left.length !== right.length) return false
    return left.every((value, index) => value === right[index])
  }
  if (Object.getPrototypeOf(left) !== Object.prototype && Object.getPrototypeOf(left) !== null) return false
  if (Object.getPrototypeOf(right) !== Object.prototype && Object.getPrototypeOf(right) !== null) return false
  const leftEntries = Object.entries(left as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  const rightEntries = Object.entries(right as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  if (leftEntries.length !== rightEntries.length) return false
  return leftEntries.every(([key, value], index) => rightEntries[index]?.[0] === key && deepEqual(value, rightEntries[index]?.[1]))
}
function sortKeys(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(sortKeys)
  if (input !== null && typeof input === "object" && Object.getPrototypeOf(input) === Object.prototype) {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(input).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) out[key] = sortKeys(value)
    return out
  }
  return input
}
function attemptBase() { return { id: LocalId, scope: PersonalScope, runId: LocalId, jobId: LocalId, stepId: LocalId, attempt: PositiveVersion, startedAt: LocalId } }
function completionSchema() { return Schema.Struct({ finishedAt: LocalId, result: Schema.optional(JsonValue), error: Schema.optional(AutomationFailure) }) }
