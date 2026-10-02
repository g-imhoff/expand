import { Data, Effect, Schema, SchemaAST, SchemaRepresentation, SchemaTransformation } from "effect"
import { CredentialReference, DefinitionReference, LocalId, PersonalScope } from "./ids.js"

export class AutomationError extends Data.TaggedError("AutomationError")<{
  readonly code: "invalid-contract" | "unsupported-schema" | "duplicate-definition" | "missing-definition" | "invalid-reference" | "invalid-binding" | "unresolved-selection" | "denied" | "handler-failed"
  readonly message: string
  readonly failure?: AutomationFailure
}> {}

export const JsonValue = Schema.Json
export type JsonValue = Schema.Json
export const EditorSchema = Schema.Struct({
  dialect: Schema.Literal("draft-2020-12"), schema: Schema.Json, definitions: Schema.Record(Schema.String, Schema.Json)
})
export type EditorSchema = typeof EditorSchema.Type
export const IntegrationConfiguration = Schema.Struct({
  schemaVersion: Schema.Literal(1), kind: Schema.Literal("integration-configuration"),
  id: LocalId, definition: DefinitionReference, configuration: JsonValue,
  credentials: Schema.Record(Schema.String, CredentialReference)
})
export type IntegrationConfiguration = typeof IntegrationConfiguration.Type
export const IntegrationDescriptor = Schema.Struct({
  schemaVersion: Schema.Literal(1), kind: Schema.Literal("integration"), definition: DefinitionReference,
  title: LocalId, capabilities: Schema.Array(LocalId).check(Schema.isUnique()), configurationSchema: EditorSchema
})
export type IntegrationDescriptor = typeof IntegrationDescriptor.Type
export const TriggerDescriptor = Schema.Struct({
  schemaVersion: Schema.Literal(1), kind: Schema.Literal("trigger"), definition: DefinitionReference,
  title: LocalId, integration: DefinitionReference, configurationSchema: EditorSchema, payloadSchema: EditorSchema
})
export type TriggerDescriptor = typeof TriggerDescriptor.Type
export const ActionDescriptor = Schema.Struct({
  schemaVersion: Schema.Literal(1), kind: Schema.Literal("action"), definition: DefinitionReference,
  title: LocalId, integration: DefinitionReference, capabilities: Schema.Array(LocalId).check(Schema.isUnique()),
  argumentsSchema: EditorSchema, resultSchema: EditorSchema
})
export type ActionDescriptor = typeof ActionDescriptor.Type
export const RoutineDescriptor = Schema.Struct({
  schemaVersion: Schema.Literal(1), kind: Schema.Literal("routine-template"), definition: DefinitionReference,
  title: LocalId, configurationSchema: EditorSchema, process: JsonValue
})
export type RoutineDescriptor = typeof RoutineDescriptor.Type
export const DefinitionDescriptor = Schema.Union([IntegrationDescriptor, TriggerDescriptor, ActionDescriptor, RoutineDescriptor])
export type DefinitionDescriptor = typeof DefinitionDescriptor.Type
export const Catalog = Schema.Struct({ schemaVersion: Schema.Literal(1), kind: Schema.Literal("catalog"), definitions: Schema.Array(DefinitionDescriptor) })
export type Catalog = typeof Catalog.Type
export const AutomationFailure = Schema.Struct({ code: LocalId, message: Schema.String, details: Schema.optional(JsonValue) })
export type AutomationFailure = typeof AutomationFailure.Type
export const InvocationContext = Schema.Struct({
  scope: PersonalScope, routineId: LocalId, configurationRevision: Schema.Int.check(Schema.isGreaterThan(0)),
  integrationId: LocalId, mode: Schema.Literals(["preview", "live"])
})
export type InvocationContext = typeof InvocationContext.Type

export const isJsonValue = (value: unknown, ancestors: ReadonlySet<object> = new Set()): value is Schema.Json => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (typeof value !== "object" || ancestors.has(value)) return false
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false
  const next = new Set(ancestors).add(value)
  const properties = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(properties).some((key) => typeof key !== "string")) return false
  if (Array.isArray(value)) {
    if (Object.keys(properties).some((key) => key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key))) return false
    for (let index = 0; index < value.length; index++) {
      const property = properties[String(index)]
      if (!property || !property.enumerable || !("value" in property) || !isJsonValue(property.value, next)) return false
    }
    return true
  }
  return Object.values(properties).every((property) => property.enumerable && "value" in property && isJsonValue(property.value, next))
}

export const decodeJson = Effect.fn("Automation.decodeJson")(<S extends Schema.ConstraintCodec<unknown, unknown, never, never>>(schema: S, value: unknown): Effect.Effect<S["Type"], AutomationError> =>
  isJsonValue(value)
    ? Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })(value).pipe(
      Effect.mapError(() => new AutomationError({ code: "invalid-contract", message: "Value does not match the registered contract" })))
    : Effect.fail(new AutomationError({ code: "invalid-contract", message: "Expected an encoded JSON value" })))

export const editorSchema = Effect.fn("Automation.editorSchema")((schema: Schema.Constraint): Effect.Effect<EditorSchema, AutomationError> =>
  Effect.try({
    try: () => {
      assertSupported(schema.ast, new Set())
      const document = SchemaRepresentation.toJsonSchemaDocument(
        SchemaRepresentation.toRepresentation(jsonEncodedAst(Schema.toEncoded(schema).ast)), { onExcessProperty: "error" })
      return Schema.decodeUnknownSync(EditorSchema)(document)
    },
    catch: () => new AutomationError({ code: "unsupported-schema", message: "Schema requires unsupported services or has no encoded JSON editor representation" })
  }))

const assertSupported = (ast: SchemaAST.AST, visited: Set<SchemaAST.AST>): void => {
  if (visited.has(ast)) return
  visited.add(ast)
  for (const check of ast.checks ?? []) assertRepresentableCheck(check)
  if ("encodingChecks" in ast) for (const check of ast.encodingChecks ?? []) assertRepresentableCheck(check)
  for (const link of ast.encoding ?? []) {
    const transformation = link.transformation
    if (transformation._tag !== "Transformation") throw new Error("Unsupported schema middleware")
    for (const getter of [transformation.decode, transformation.encode]) {
      if ((getter._tag === "TransformEffect" || getter._tag === "TransformOptionalEffect") &&
        getter !== SchemaTransformation.numberFromString.decode && getter !== SchemaTransformation.numberFromString.encode) {
        throw new Error("Unsupported effectful codec")
      }
    }
    assertSupported(link.to, visited)
  }
  switch (ast._tag) {
    case "Declaration":
      if (ast !== Schema.Json.ast && ast !== Schema.toEncoded(Schema.Json).ast) throw new Error("Unsupported declaration")
      break
    case "Objects":
      for (const property of ast.propertySignatures) assertSupported(property.type, visited)
      for (const signature of ast.indexSignatures) {
        assertSupported(signature.parameter, visited)
        assertSupported(signature.type, visited)
      }
      break
    case "Arrays":
      for (const element of ast.elements) assertSupported(element, visited)
      for (const element of ast.rest) assertSupported(element, visited)
      break
    case "Union":
      for (const member of ast.types) {
        if (ast.context?.isOptional && member._tag === "Undefined") continue
        assertSupported(member, visited)
      }
      break
    case "Suspend":
      assertSupported(ast.thunk(), visited)
      break
  }
  const encoded = Schema.toEncoded(Schema.make(ast)).ast
  if (["Unknown", "Any", "ObjectKeyword", "BigInt", "Symbol", "UniqueSymbol", "Void"].includes(encoded._tag)) throw new Error("Non-JSON encoded type")
  if (encoded._tag === "Undefined" && !encoded.context?.isOptional) throw new Error("Non-JSON undefined")
}

const jsonEncodedAst = (ast: SchemaAST.AST, cache = new Map<SchemaAST.AST, SchemaAST.AST>()): SchemaAST.AST => {
  const cached = cache.get(ast)
  if (cached) return cached
  const recur = (child: SchemaAST.AST): SchemaAST.AST => jsonEncodedAst(child, cache)
  let result: SchemaAST.AST
  switch (ast._tag) {
    case "Union":
      result = new SchemaAST.Union(
        ast.types.filter((member) => !(ast.context?.isOptional && member._tag === "Undefined")).map(recur),
        ast.options, ast.annotations, ast.checks, ast.encoding, ast.context, ast.encodingChecks)
      break
    case "Objects":
      result = new SchemaAST.Objects(
        ast.propertySignatures.map((property) => new SchemaAST.PropertySignature(property.name, recur(property.type))),
        ast.indexSignatures.map((signature) => new SchemaAST.IndexSignature(recur(signature.parameter), recur(signature.type))),
        ast.annotations, ast.checks, ast.encoding, ast.context, ast.encodingChecks)
      break
    case "Arrays":
      result = new SchemaAST.Arrays(ast.isMutable, ast.elements.map(recur), ast.rest.map(recur), ast.annotations, ast.checks, ast.encoding, ast.context, ast.encodingChecks)
      break
    case "Suspend":
      result = new SchemaAST.Suspend(() => recur(ast.thunk()), ast.annotations, ast.checks, ast.encoding, ast.context)
      break
    default:
      result = ast
  }
  cache.set(ast, result)
  return result
}

const assertRepresentableCheck = (check: SchemaAST.Check<unknown>): void => {
  if (check.annotations?.toJsonSchema) return
  if (check._tag === "FilterGroup") {
    for (const child of check.checks) assertRepresentableCheck(child)
    return
  }
  throw new Error("Validation check has no editor representation")
}
