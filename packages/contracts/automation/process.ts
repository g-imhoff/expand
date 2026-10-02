import { Effect, Schema } from "effect"
import { AutomationError, decodeJson, IntegrationConfiguration, isJsonValue, JsonValue } from "./descriptors.js"
import { ConfigurationReference, DefinitionReference, IntegrationReference, LocalId, PersonalScope } from "./ids.js"
import { JevDecisionResult } from "./run.js"

export interface BindingSources {
  readonly trigger: Schema.Json
  readonly configuration: Schema.Json
  readonly decision?: Schema.Json
}

export const Binding = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("literal"), value: JsonValue }),
  Schema.Struct({
    kind: Schema.Literal("field"), source: Schema.Literals(["trigger", "configuration", "decision"]),
    path: Schema.Array(LocalId).check(Schema.isMinLength(1))
  })
])
export type Binding = typeof Binding.Type
export type FieldPath<T, Seen = never> = T extends object ? T extends Seen ? ReadonlyArray<string> :
  T extends ReadonlyArray<infer Item> ? readonly [`${number}`] | readonly [`${number}`, ...FieldPath<Item, Seen | T>] :
  { [Key in keyof T & string]: readonly [Key] | readonly [Key, ...FieldPath<NonNullable<T[Key]>, Seen | T>] }[keyof T & string] : never
export const fieldBinding = <S extends Schema.Constraint, P extends FieldPath<S["Encoded"]>>(
  _schema: S, source: "trigger" | "configuration" | "decision", path: P
): Extract<Binding, { kind: "field" }> => ({ kind: "field", source, path })
export const literalBinding = (value: Schema.Json): Extract<Binding, { kind: "literal" }> => ({ kind: "literal", value })
export const ActionStep = Schema.Struct({
  id: LocalId, action: DefinitionReference, integration: IntegrationReference,
  bindings: Schema.Record(Schema.String, Binding)
})
export type ActionStep = typeof ActionStep.Type
export const JevDecision = Schema.Struct({
  kind: Schema.Literal("jev"), provider: Schema.Literal("opencode-zen"), model: Schema.Literal("jev"),
  version: Schema.Literal("1.13"), outcomes: Schema.Array(LocalId).check(Schema.isMinLength(1), Schema.isUnique())
})
export type JevDecision = typeof JevDecision.Type
export const ProcessDefinition = Schema.Struct({
  schemaVersion: Schema.Literal(1), kind: Schema.Literal("process"),
  trigger: Schema.Struct({ definition: DefinitionReference, integration: IntegrationReference, configuration: JsonValue }),
  decision: Schema.optional(JevDecision), actions: Schema.Record(Schema.String, Schema.Array(ActionStep))
})
export type ProcessDefinition = typeof ProcessDefinition.Type
export const RoutineConfiguration = Schema.Struct({
  schemaVersion: Schema.Literal(1), kind: Schema.Literal("routine-configuration"),
  reference: ConfigurationReference, template: Schema.optional(DefinitionReference), scope: PersonalScope,
  configuration: JsonValue, integrations: Schema.Array(IntegrationConfiguration), process: ProcessDefinition
})
export type RoutineConfiguration = typeof RoutineConfiguration.Type
export type ActionSelection =
  | { readonly kind: "selected"; readonly outcomeId: string; readonly actions: ReadonlyArray<ActionStep> }
  | { readonly kind: "unresolved"; readonly reason: string; readonly actions: readonly [] }

export const validateProcess = Effect.fn("Automation.validateProcess")(function*(input: unknown) {
  const process = yield* decodeJson(ProcessDefinition, input)
  const outcomes = process.decision?.outcomes ?? ["triggered"]
  const stepIds = new Set<string>()
  for (const [outcome, steps] of Object.entries(process.actions)) {
    if (!outcomes.includes(outcome)) return yield* new AutomationError({ code: "invalid-reference", message: "Unknown process outcome" })
    for (const step of steps) {
      if (stepIds.has(step.id)) return yield* new AutomationError({ code: "invalid-reference", message: "Duplicate process step ID" })
      stepIds.add(step.id)
      for (const [argument, binding] of Object.entries(step.bindings)) {
        if (forbiddenFields.has(argument)) return yield* bindingError("Unsafe argument field")
        if (binding.kind === "field" && (binding.path.some((part) => forbiddenFields.has(part)) ||
          (binding.source === "decision" && process.decision === undefined))) return yield* bindingError("Unsafe or unavailable binding source")
      }
    }
  }
  return process
})

export const deriveSelectedActions = Effect.fn("Automation.deriveSelectedActions")(function*(input: unknown, decisionInput?: unknown): Effect.fn.Return<ActionSelection, AutomationError> {
  const process = yield* validateProcess(input)
  if (process.decision === undefined) {
    if (decisionInput !== undefined) return yield* new AutomationError({ code: "invalid-reference", message: "Process has no decision" })
    return { kind: "selected", outcomeId: "triggered", actions: ownActions(process, "triggered") }
  }
  if (decisionInput === undefined) return { kind: "unresolved", reason: "Decision has not selected an outcome", actions: [] }
  const decision = yield* decodeJson(JevDecisionResult, decisionInput)
  if (decision.kind === "abstained") return { kind: "unresolved", reason: decision.reason, actions: [] }
  if (!process.decision.outcomes.includes(decision.outcomeId)) return yield* new AutomationError({ code: "invalid-reference", message: "Decision selected an unknown outcome" })
  return { kind: "selected", outcomeId: decision.outcomeId, actions: ownActions(process, decision.outcomeId) }
})

export const resolveBindings = Effect.fn("Automation.resolveBindings")(function*(input: unknown, sources: BindingSources) {
  const bindings = yield* decodeJson(Schema.Record(Schema.String, Binding), input)
  const resolved: Record<string, Schema.Json> = Object.create(null)
  for (const [argument, binding] of Object.entries(bindings)) {
    if (forbiddenFields.has(argument)) return yield* bindingError("Unsafe argument field")
    if (binding.kind === "literal") {
      resolved[argument] = binding.value
      continue
    }
    let value: unknown = sources[binding.source]
    for (const field of binding.path) {
      if (forbiddenFields.has(field) || value === null || typeof value !== "object") return yield* bindingError("Unknown or unsafe field path")
      const property = Object.getOwnPropertyDescriptor(value, field)
      if (!property || !property.enumerable || !("value" in property)) return yield* bindingError("Binding field must be an own data field")
      value = property.value
    }
    if (!isJsonValue(value)) return yield* bindingError("Binding source is not encoded JSON")
    resolved[argument] = value
  }
  return resolved
})

export const resolveActionArguments = Effect.fn("Automation.resolveActionArguments")(function*<S extends Schema.ConstraintCodec<unknown, unknown, never, never>>(
  schema: S, bindings: unknown, sources: BindingSources
) {
  const encoded = yield* resolveBindings(bindings, sources)
  const decoded = yield* decodeJson(schema, encoded)
  return { encoded, decoded }
})

const ownActions = (process: ProcessDefinition, outcomeId: string): ReadonlyArray<ActionStep> =>
  Object.hasOwn(process.actions, outcomeId) ? process.actions[outcomeId]! : []

const forbiddenFields = new Set(["__proto__", "prototype", "constructor"])
const bindingError = (message: string): AutomationError => new AutomationError({ code: "invalid-binding", message })
