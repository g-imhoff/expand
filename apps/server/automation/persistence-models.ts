import { isSqlError } from "effect/sql/SqlError"
import { Data, Effect, Schema } from "effect"
import { AutomationRun, decodeJson, JsonValue, LocalId, RoutineConfiguration, sameDefinition, validateProcess } from "@expand/contracts/automation"
import type { Delivery } from "@expand/contracts/automation"

export class StorageError extends Data.TaggedError("AutomationStorageError")<{
  readonly code: "invalid" | "conflict" | "missing" | "storage"
  readonly message: string
}> {}

export { Attempt, CredentialStatus, Delivery, Job, RoutineStatus } from "@expand/contracts/automation"

export const StoredCredential = Schema.Struct({
  schemaVersion: Schema.Literal(1), kind: Schema.Literal("credential"),
  credentialId: LocalId, secret: JsonValue
})
export type StoredCredential = typeof StoredCredential.Type
export const decode = <S extends Schema.ConstraintCodec<unknown, unknown, never, never>>(schema: S, input: unknown): Effect.Effect<S["Type"], StorageError> =>
  decodeJson(schema, input).pipe(Effect.mapError(() => new StorageError({ code: "invalid", message: "Invalid persistence value" })))
export const readJson = <S extends Schema.ConstraintCodec<unknown, unknown, never, never>>(schema: S, json: string) => Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(json).pipe(Effect.mapError(() => new StorageError({ code: "invalid", message: "Invalid stored JSON" })), Effect.flatMap((value) => decode(schema, value)))
export const guard = (condition: boolean, code: StorageError["code"] = "invalid"): Effect.Effect<void, StorageError> => condition ? Effect.void : Effect.fail(new StorageError({ code, message: "Persistence invariant rejected" }))
export const same = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right)
export const canonical = (input: unknown): string => JSON.stringify(input, (_, value) => value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)
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

export const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

function storageFailure() { return new StorageError({ code: "storage", message: "Storage operation failed; commit outcome may be unknown" }) }
