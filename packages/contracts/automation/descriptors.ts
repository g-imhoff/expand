import { Data, Effect, Schema, SchemaAST, SchemaRepresentation } from "effect"
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
  const prototype = Object.getPrototypeOf(value)
  if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false
  for (let current: object | null = value; current !== null; current = Object.getPrototypeOf(current)) {
    const hook = Object.getOwnPropertyDescriptor(current, "toJSON")
    if (hook) {
      if (!("value" in hook) || typeof hook.value === "function") return false
      break
    }
  }
  const next = new Set(ancestors).add(value)
  const properties = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(properties).some((key) => typeof key !== "string")) return false
  if (Array.isArray(value)) {
    if (Object.keys(properties).some((key) => key !== "length" && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))) return false
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
  if (!["Declaration", "Objects", "Arrays", "Union", "Suspend", "String", "Number", "Boolean", "Literal", "Null", "Never", "Undefined"].includes(ast._tag)) {
    throw new Error("Unsupported encoded schema node")
  }
  for (const check of ast.checks ?? []) descriptorCheck(check, ast)
  if ("encodingChecks" in ast) for (const check of ast.encodingChecks ?? []) descriptorCheck(check, ast)
  for (const link of ast.encoding ?? []) {
    const transformation = link.transformation
    if (transformation._tag !== "Transformation") throw new Error("Unsupported schema middleware")
    for (const getter of [transformation.decode, transformation.encode]) {
      if (getter._tag !== "Transform" && getter._tag !== "Passthrough") throw new Error("Unsupported codec getter")
    }
    assertSupported(link.to, visited)
  }
  if (ast.encoding?.length) assertFiniteTransformation(ast)
  switch (ast._tag) {
    case "Literal":
      if (!isJsonValue(ast.literal)) throw new Error("Non-JSON literal")
      break
    case "Declaration":
      if (ast !== Schema.Json.ast && ast !== Schema.toEncoded(Schema.Json).ast) throw new Error("Unsupported declaration")
      break
    case "Objects":
      for (const property of ast.propertySignatures) {
        if (typeof property.name !== "string") throw new Error("Non-JSON property name")
        assertSupported(property.type, visited)
      }
      for (const signature of ast.indexSignatures) {
        if (signature.parameter._tag !== "String" || signature.parameter.checks || signature.parameter.encoding) throw new Error("Unsupported record key constraint")
        assertSupported(signature.parameter, visited)
        assertSupported(signature.type, visited)
      }
      break
    case "Arrays":
      for (const element of ast.elements) assertSupported(element, visited)
      for (const element of ast.rest) assertSupported(element, visited)
      break
    case "Union":
      if (ast.options?.mode === "oneOf" && containsJsonDeclaration(ast, new Set())) throw new Error("JSON declaration makes oneOf approximate")
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
  if (ast._tag === "Arrays") {
    const preserved = new Set(checkLeaves(encoded.checks ?? []))
    if (checkLeaves(ast.checks ?? []).some((check) => !preserved.has(check))) throw new Error("Array checks are lost in the encoded schema")
  }
  if (["Unknown", "Any", "ObjectKeyword", "BigInt", "Symbol", "UniqueSymbol", "Void"].includes(encoded._tag)) throw new Error("Non-JSON encoded type")
  if (encoded._tag === "Undefined" && !encoded.context?.isOptional) throw new Error("Non-JSON undefined")
}

const containsJsonDeclaration = (ast: SchemaAST.AST, visited: Set<SchemaAST.AST>): boolean => {
  if (visited.has(ast)) return false
  visited.add(ast)
  if (ast.encoding?.some((link) => containsJsonDeclaration(link.to, visited))) return true
  switch (ast._tag) {
    case "Declaration": return ast === Schema.Json.ast || ast === Schema.toEncoded(Schema.Json).ast
    case "Objects": return ast.propertySignatures.some((property) => containsJsonDeclaration(property.type, visited)) ||
      ast.indexSignatures.some((signature) => containsJsonDeclaration(signature.type, visited))
    case "Arrays": return [...ast.elements, ...ast.rest].some((element) => containsJsonDeclaration(element, visited))
    case "Union": return ast.types.some((member) => containsJsonDeclaration(member, visited))
    case "Suspend": return containsJsonDeclaration(ast.thunk(), visited)
    default: return false
  }
}

const checkLeaves = (checks: ReadonlyArray<SchemaAST.Check<unknown>>): ReadonlyArray<SchemaAST.Check<unknown>> =>
  checks.flatMap((check) => check._tag === "FilterGroup" ? checkLeaves(check.checks) : [check])

const jsonEncodedAst = (ast: SchemaAST.AST, cache = new Map<SchemaAST.AST, SchemaAST.AST>()): SchemaAST.AST => {
  const cached = cache.get(ast)
  if (cached) return cached
  const recur = (child: SchemaAST.AST): SchemaAST.AST => jsonEncodedAst(child, cache)
  const checks = ast.checks?.map((check) => descriptorCheck(check, ast)) as SchemaAST.Checks | undefined
  let result: SchemaAST.AST
  switch (ast._tag) {
    case "Union":
      result = new SchemaAST.Union(
        ast.types.filter((member) => !(ast.context?.isOptional && member._tag === "Undefined")).map(recur),
        ast.options, ast.annotations, checks, ast.encoding, ast.context, ast.encodingChecks)
      break
    case "Objects":
      result = new SchemaAST.Objects(
        ast.propertySignatures.map((property) => new SchemaAST.PropertySignature(property.name, recur(property.type))),
        ast.indexSignatures.map((signature) => new SchemaAST.IndexSignature(recur(signature.parameter), recur(signature.type))),
        ast.annotations, checks, ast.encoding, ast.context, ast.encodingChecks)
      break
    case "Arrays":
      result = new SchemaAST.Arrays(ast.isMutable, ast.elements.map(recur), ast.rest.map(recur), ast.annotations, checks, ast.encoding, ast.context, ast.encodingChecks)
      break
    case "Suspend":
      result = new SchemaAST.Suspend(() => recur(ast.thunk()), ast.annotations, checks, ast.encoding, ast.context)
      break
    case "String": result = new SchemaAST.String(ast.annotations, checks, ast.encoding, ast.context); break
    case "Number": result = new SchemaAST.Number(ast.annotations, [Schema.isFinite(), ...checks ?? []], ast.encoding, ast.context); break
    case "Boolean": result = new SchemaAST.Boolean(ast.annotations, checks, ast.encoding, ast.context); break
    case "Literal": result = new SchemaAST.Literal(ast.literal, ast.annotations, checks, ast.encoding, ast.context); break
    default:
      result = ast
  }
  cache.set(ast, result)
  return result
}

const assertFiniteTransformation = (ast: SchemaAST.AST): void => {
  const schema = Schema.make<Schema.Codec<unknown, unknown>>(ast)
  const encoded = Schema.toEncoded(schema)
  const values = finiteValues(encoded.ast)
  if (!values.length || values.length > 256) throw new Error("Codec has no supported finite encoded domain")
  for (const value of values) {
    if (!Schema.is(encoded)(value)) continue
    const decoded = Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value)
    const roundtrip = Schema.encodeUnknownSync(schema, { onExcessProperty: "error" })(decoded)
    if (!Object.is(roundtrip, value)) throw new Error("Codec is not reversible on its encoded domain")
  }
}

const finiteValues = (ast: SchemaAST.AST): ReadonlyArray<Schema.Json> => {
  if (ast._tag === "Literal" && isJsonValue(ast.literal)) return [ast.literal]
  if (ast._tag === "Null") return [null]
  if (ast._tag === "Boolean") return [false, true]
  if (ast._tag === "Union") return ast.types.flatMap((member) => finiteValues(member))
  throw new Error("Unsupported transformation of an open encoded domain")
}

const descriptorCheck = (check: SchemaAST.Check<unknown>, ast: SchemaAST.AST): SchemaAST.Check<unknown> => {
  if (check._tag === "FilterGroup") {
    return new SchemaAST.FilterGroup(check.checks.map((child) => descriptorCheck(child, ast)) as [SchemaAST.Check<unknown>, ...Array<SchemaAST.Check<unknown>>])
  }
  const representation = check.annotations?.representation
  const payload = representation?.payload as Record<string, unknown> | null | undefined
  const bound = (name: string): number => {
    const value = payload?.[name]
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid constraint bound")
    return value
  }
  const isString = ast._tag === "String" || ast._tag === "Literal" && typeof ast.literal === "string"
  const isNumber = ast._tag === "Number" || ast._tag === "Literal" && typeof ast.literal === "number"
  let fragment: Schema.Json
  switch (representation?.id) {
    case "effect/schema/isPattern": {
      if (!isString || payload?.["flags"] !== "u" || typeof payload["source"] !== "string") throw new Error("Unsupported pattern flags")
      fragment = { pattern: payload["source"] }
      break
    }
    case "effect/schema/isMinLength":
    case "effect/schema/isMaxLength":
    case "effect/schema/isBetweenLength": {
      const minimum = representation.id === "effect/schema/isMaxLength" ? 0 : bound(representation.id === "effect/schema/isMinLength" ? "minLength" : "minimum")
      const maximum = representation.id === "effect/schema/isMinLength" ? undefined : bound(representation.id === "effect/schema/isMaxLength" ? "maxLength" : "maximum")
      if (isString) {
        const lower = minimum <= 1 ? { minLength: minimum } : { pattern: utf16MinimumPattern(minimum) }
        fragment = maximum === undefined ? lower : { allOf: [lower, { not: { pattern: utf16MinimumPattern(maximum + 1) } }] }
      } else if (ast._tag === "Arrays") {
        fragment = { minItems: minimum, ...(maximum === undefined ? {} : { maxItems: maximum }) }
      } else throw new Error("Unsupported length constraint")
      break
    }
    case "effect/schema/isMinCodePoints":
    case "effect/schema/isMaxCodePoints":
    case "effect/schema/isBetweenCodePoints":
      if (!isString) throw new Error("Unsupported code point constraint")
      fragment = representation.id === "effect/schema/isMinCodePoints" ? { minLength: bound("minCodePoints") } :
        representation.id === "effect/schema/isMaxCodePoints" ? { maxLength: bound("maxCodePoints") } :
        { minLength: bound("minimum"), maxLength: bound("maximum") }
      break
    case "effect/schema/isFinite":
    case "effect/schema/isInt":
    case "effect/schema/isGreaterThan":
    case "effect/schema/isGreaterThanOrEqualTo":
    case "effect/schema/isLessThan":
    case "effect/schema/isLessThanOrEqualTo":
      if (!isNumber) throw new Error("Unsupported numeric constraint")
      fragment = representation.id === "effect/schema/isFinite" ? { type: "number" } :
        representation.id === "effect/schema/isInt" ? { type: "integer", minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER } :
        representation.id === "effect/schema/isGreaterThan" ? { exclusiveMinimum: bound("exclusiveMinimum") } :
        representation.id === "effect/schema/isGreaterThanOrEqualTo" ? { minimum: bound("minimum") } :
        representation.id === "effect/schema/isLessThan" ? { exclusiveMaximum: bound("exclusiveMaximum") } : { maximum: bound("maximum") }
      break
    case "effect/schema/isUnique":
      if (ast._tag !== "Arrays" || [...ast.elements, ...ast.rest].some((element) => !isPrimitiveAst(element))) throw new Error("Unsupported object equality constraint")
      fragment = { uniqueItems: true }
      break
    default:
      throw new Error("Unsupported validation check")
  }
  return new SchemaAST.Filter(check.run, { toJsonSchema: () => fragment }, check.aborted)
}

const isPrimitiveAst = (ast: SchemaAST.AST): boolean =>
  !ast.encoding?.length && (["String", "Number", "Boolean", "Literal", "Null"].includes(ast._tag) || ast._tag === "Union" && ast.types.every(isPrimitiveAst))

const utf16MinimumPattern = (minimum: number): string => {
  if (!Number.isInteger(minimum) || minimum < 0 || minimum > 512) throw new Error("Unsupported UTF-16 length bound")
  const astral = "[\\u{10000}-\\u{10FFFF}]"
  const single = "[^\\u{10000}-\\u{10FFFF}]"
  const alternatives = Array.from({ length: Math.floor(minimum / 2) + 1 }, (_, pairs) =>
    `${pairs === 0 ? "" : `(?=(?:${single}*${astral}){${pairs}})`}(?=[\\s\\S]{${minimum - pairs},})`)
  return `^(?:${alternatives.join("|")})`
}
