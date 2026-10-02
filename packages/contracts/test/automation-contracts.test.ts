import { it } from "@effect/vitest"
import { Effect, Result, Schema, SchemaGetter } from "effect"
import { describe, expect, expectTypeOf, vi } from "vitest"
import {
  ActionDescriptor, ActionOutcome, AutomationRun, Catalog, CredentialReference, decodeJson, DefinitionReference,
  editorSchema, IntegrationConfiguration, IntegrationDescriptor, InvocationAuthority, isJsonValue, JevDecisionRequest, JevDecisionResult,
  ProcessDefinition, RoutineConfiguration, RoutineDescriptor, RunState, TriggerDescriptor
} from "@expand/contracts/automation"
import type { ContextFreeCodec } from "@expand/contracts/automation"

const nonJsonDate = Schema.decodeUnknownSync(Schema.DateFromString)("2026-10-02T00:00:00Z")
const reference = { id: "fiction:definition", version: 2 }
const integrationReference = { id: "mail", definition: reference }
const editor = { dialect: "draft-2020-12", schema: { type: "object", properties: {} }, definitions: {} }
const process = { schemaVersion: 1, kind: "process", trigger: { definition: reference, integration: integrationReference, configuration: {} }, actions: { triggered: [] } }
const configurationReference = { routineId: "personal", revision: 3 }
const scope = { ownerId: "owner", projectId: "project" }
const credential = { schemaVersion: 1, kind: "credential-reference", credentialId: "gmail-account" }
const integration = { schemaVersion: 1, kind: "integration-configuration", id: "mail", definition: reference, configuration: { label: "arbitrary application string" }, credentials: { account: credential } }
const authority = { schemaVersion: 1, kind: "invocation-authority", scope, configuration: configurationReference, integrationIds: ["mail"], actionGrants: [{ action: reference, integrationId: "mail", capabilities: ["send"] }] }
const configuration = { schemaVersion: 1, kind: "routine-configuration", reference: configurationReference, template: reference, scope, configuration: {}, integrations: [integration], process }
const run = { schemaVersion: 1, kind: "run", id: "run-1", scope, configuration: configurationReference, input: { kind: "input-reference", id: "original-message" }, mode: "live", authority, state: { kind: "queued" }, actions: [] }
const descriptor = { schemaVersion: 1, definition: reference, title: "Fiction" }
const descriptors = [
  { ...descriptor, kind: "integration", capabilities: ["send"], configurationSchema: editor },
  { ...descriptor, kind: "trigger", integration: reference, configurationSchema: editor, payloadSchema: editor },
  { ...descriptor, kind: "action", integration: reference, capabilities: ["send"], argumentsSchema: editor, resultSchema: editor },
  { ...descriptor, kind: "routine-template", configurationSchema: editor, process }
]
const roundtrip = Effect.fn("Test.roundtrip")(function*(schema: ContextFreeCodec, input: unknown) {
  const decoded = yield* decodeJson(schema, input)
  const encoded = yield* Schema.encodeUnknownEffect(schema, { onExcessProperty: "error" })(decoded)
  expect(encoded).toEqual(input)
})
const reject = Effect.fn("Test.reject")(function*(schema: ContextFreeCodec, input: unknown) {
  expect(Result.isFailure(yield* decodeJson(schema, input).pipe(Effect.result))).toBe(true)
})

describe("versioned automation contracts", () => {
  it.effect("roundtrips custom configurations without template provenance", () =>
    Effect.gen(function*() {
      const custom = { ...configuration }
      Reflect.deleteProperty(custom, "template")
      yield* roundtrip(RoutineConfiguration, custom)
      expectTypeOf<typeof RoutineConfiguration.Type.template>().toEqualTypeOf<DefinitionReference | undefined>()
      const descriptor = yield* editorSchema(RoutineConfiguration)
      const required = (descriptor.schema as Record<string, Schema.Json>)["required"]
      expect(required).not.toContain("template")
      for (const template of [null, {}, { ...reference, version: 0 }, { ...reference, id: "invalid" }]) {
        yield* reject(RoutineConfiguration, { ...custom, template })
      }
    }))

  for (const key of ["4294967295", "4294967296", "9007199254740991", "9007199254740992", "01", "-1", "1.0", "1e0"]) {
    for (const value of ["json", undefined, () => "non-json"]) {
      it.effect(`rejects array property ${key} with ${typeof value} value`, () =>
        Effect.gen(function*() {
          const array: Array<unknown> = []
          Object.defineProperty(array, key, { value, enumerable: true })
          expect(isJsonValue(array)).toBe(false)
          yield* reject(Schema.Json, array)
        }))
    }
  }

  it.effect("rejects discarded numeric array properties at the decoder boundary", () =>
    Effect.gen(function*() {
      for (const value of [true, undefined]) {
        const array: Array<unknown> = []
        Object.defineProperty(array, "4294967295", { value, enumerable: true })
        yield* reject(Schema.Json, array)
      }
    }))

  it.effect("rejects sparse, accessor, hidden, symbolic and extra array properties without calling getters", () =>
    Effect.gen(function*() {
      const getter = vi.fn(() => "accessed")
      const accessor: Array<unknown> = ["value"]
      Object.defineProperty(accessor, "0", { get: getter, enumerable: true })
      const hidden: Array<unknown> = ["value"]
      Object.defineProperty(hidden, "0", { value: "value", enumerable: false })
      const extra = Object.assign(["value"], { extra: "discarded" })
      const symbolic = Object.assign(["value"], { [Symbol("extra")]: "discarded" })
      for (const value of [new Array(1), ["value", , "value"], accessor, hidden, extra, symbolic]) {
        expect(isJsonValue(value)).toBe(false)
        yield* reject(Schema.Json, value)
      }
      expect(getter).not.toHaveBeenCalled()
    }))

  it.effect("roundtrips dense arrays and nested JSON without losing data", () =>
    Effect.gen(function*() {
      for (const value of [[], [null, true, false, 1, "value"], [[1], { nested: ["value"] }], Object.freeze([1, 2])]) {
        expect(isJsonValue(value)).toBe(true)
        yield* roundtrip(Schema.Json, value)
        const codec = Schema.fromJsonString(Schema.Json)
        const serialized = yield* Schema.encodeEffect(codec)(value)
        expect(yield* Schema.decodeUnknownEffect(codec)(serialized)).toEqual(value)
      }
      yield* roundtrip(Schema.Json, { toJSON: "ordinary field", values: [1] })
    }))

  it("rejects array prototypes that change JSON serialization", () => {
    const hook = vi.fn(() => "changed")
    const value = Object.setPrototypeOf([1], { toJSON: hook })
    expect(isJsonValue(value)).toBe(false)
    expect(Result.isFailure(Effect.runSync(decodeJson(Schema.Json, value).pipe(Effect.result)))).toBe(true)
    expect(hook).not.toHaveBeenCalled()
  })

  it("rejects inherited JSON hooks and accessors without executing them", () => {
    for (const prototype of [Array.prototype, Object.prototype]) {
      const previous = Object.getOwnPropertyDescriptor(prototype, "toJSON")
      const hook = vi.fn(() => "changed")
      try {
        for (const descriptor of [{ value: hook }, { get: hook }]) {
          Object.defineProperty(prototype, "toJSON", { ...descriptor, configurable: true })
          for (const value of prototype === Array.prototype ? [[1]] : [[1], { value: 1 }]) {
            expect(isJsonValue(value)).toBe(false)
            expect(Result.isFailure(Effect.runSync(decodeJson(Schema.Json, value).pipe(Effect.result)))).toBe(true)
          }
        }
        expect(hook).not.toHaveBeenCalled()
      } finally {
        if (previous) Object.defineProperty(prototype, "toJSON", previous)
        else Reflect.deleteProperty(prototype, "toJSON")
      }
    }
  })

  it.effect("represents exact UTF-16 string length boundaries", () =>
    Effect.gen(function*() {
      for (const minimum of [2, 3, 4, 64, 128, 512]) {
        const schema = Schema.String.check(Schema.isMinLength(minimum))
        const descriptor = yield* editorSchema(schema)
        expect(descriptor.schema).toMatchObject({ type: "string", pattern: expect.any(String) })
        const pattern = (descriptor.schema as Record<string, Schema.Json>)["pattern"]
        expect(typeof pattern).toBe("string")
        if (typeof pattern !== "string") throw new Error("Missing exact length pattern")
        for (const value of ["", "a", "ab", "abc", "abcd", "😀", "😀a", "a😀", "😀😀", "\n", "a\n", "\ud800", "a".repeat(minimum - 1), "a".repeat(minimum), "😀".repeat(minimum / 2), "😀".repeat(minimum / 2 - 1) + "a"]) {
          const accepted = Result.isSuccess(yield* decodeJson(schema, value).pipe(Effect.result))
          expect(new RegExp(pattern, "u").test(value), `minimum ${minimum}, value ${value}`).toBe(accepted)
        }
      }
    }))


  it.effect("preserves exact maximum UTF-16 lengths including astral characters", () =>
    Effect.gen(function*() {
      for (const maximum of [0, 1, 2, 3, 4]) {
        const schema = Schema.String.check(Schema.isMaxLength(maximum))
        const descriptor = yield* editorSchema(schema)
        const clauses = (descriptor.schema as Record<string, Schema.Json>)["allOf"] as ReadonlyArray<Record<string, Schema.Json>>
        const not = clauses[1]!["not"] as Record<string, Schema.Json>
        const pattern = not["pattern"]
        expect(typeof pattern).toBe("string")
        if (typeof pattern !== "string") throw new Error("Missing maximum length pattern")
        for (const value of ["", "a", "ab", "abc", "abcd", "abcde", "😀", "😀a", "a😀", "😀😀", "😀😀a", "a\n", "\ud800"]) {
          const accepted = Result.isSuccess(yield* decodeJson(schema, value).pipe(Effect.result))
          expect(!new RegExp(pattern, "u").test(value), `maximum ${maximum}, value ${value}`).toBe(accepted)
        }
      }
    }))

  it.effect("preserves safe integer bounds in editor descriptors", () =>
    Effect.gen(function*() {
      expect((yield* editorSchema(Schema.Int)).schema).toMatchObject({
        type: "integer", minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER
      })
      yield* reject(Schema.Int, Number.MAX_SAFE_INTEGER + 1)
    }))

  for (const [name, schema, expected] of [
    ["plain", Schema.Number, { type: "number" }],
    ["bounded", Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThan(2)), { type: "number", minimum: 0, exclusiveMaximum: 2 }],
    ["finite control", Schema.Finite, { type: "number" }],
    ["integer control", Schema.Int, { type: "integer", minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }]
  ] as const) {
    it.effect(`describes ${name} numbers using only finite JSON numbers`, () =>
      Effect.gen(function*() {
        expect((yield* editorSchema(schema)).schema).toEqual(expected)
        for (const value of ["NaN", "Infinity", "-Infinity", Number.NaN, Infinity, -Infinity]) yield* reject(schema, value)
        yield* roundtrip(schema, 1)
      }))
  }

  for (const [name, wrap, expected] of [
    ["object", (schema: ContextFreeCodec) => Schema.Struct({ value: schema }), { properties: { value: { type: "number", minimum: 0, exclusiveMaximum: 2 } } }],
    ["array", (schema: ContextFreeCodec) => Schema.Array(schema), { items: { type: "number", minimum: 0, exclusiveMaximum: 2 } }],
    ["record", (schema: ContextFreeCodec) => Schema.Record(Schema.String, schema), { additionalProperties: { type: "number", minimum: 0, exclusiveMaximum: 2 } }],
    ["union", (schema: ContextFreeCodec) => Schema.Union([schema, Schema.Null]), { anyOf: [{ type: "number", minimum: 0, exclusiveMaximum: 2 }, { type: "null" }] }],
    ["optional", (schema: ContextFreeCodec) => Schema.Struct({ value: Schema.optional(schema) }), { properties: { value: { anyOf: [{ type: "number", minimum: 0, exclusiveMaximum: 2 }] } } }]
  ] as const) {
    it.effect(`preserves finite numeric bounds inside ${name} descriptors`, () =>
      Effect.gen(function*() {
        const schema = wrap(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThan(2)))
        expect((yield* editorSchema(schema)).schema).toMatchObject(expected)
      }))
  }

  it.effect("rejects partial numeric-string codecs and decoded refinements before describing them", () =>
    Effect.gen(function*() {
      for (const value of ["foo", "not-a-number", "Infinity", "-Infinity", "NaN"]) yield* reject(Schema.FiniteFromString, value)
      const result = yield* editorSchema(Schema.FiniteFromString).pipe(Effect.result)
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure.code).toBe("unsupported-schema")
    }))

  for (const [name, check, invalid] of [
    ["uniqueness", Schema.isUnique(), ["1", "1"]],
    ["nonstructural minimum length", Schema.isMinLength(2, { "~structural": false }), ["1"]],
    ["nonstructural maximum length", Schema.isMaxLength(2, { "~structural": false }), ["1", "2", "3"]],
    ["nonstructural length range", Schema.isBetweenLength(2, 2, { "~structural": false }), ["1"]],
    ["grouped uniqueness and length", Schema.isUnique().and(Schema.isMinLength(2)), ["1", "1"]]
  ] as const) {
    for (const [shape, wrapSchema, wrapValue] of [
      ["array", (schema: ContextFreeCodec) => schema, (value: ReadonlyArray<string>) => value],
      ["object", (schema: ContextFreeCodec) => Schema.Struct({ counts: schema }), (value: ReadonlyArray<string>) => ({ counts: value })],
      ["nested arrays", (schema: ContextFreeCodec) => Schema.Array(Schema.Struct({ counts: schema })), (value: ReadonlyArray<string>) => [{ counts: value }]]
    ] as const) {
      it.effect(`rejects lost ${name} over transformed elements inside ${shape}`, () =>
        Effect.gen(function*() {
          const count = Schema.Literals(["1", "2", "3"]).pipe(Schema.decodeTo(Schema.Finite, {
            decode: SchemaGetter.transform(Number), encode: SchemaGetter.transform((value) => String(value) as "1" | "2" | "3")
          }))
          const schema = wrapSchema(Schema.Array(count).check(check))
          yield* roundtrip(schema, wrapValue(["1", "2"]))
          yield* reject(schema, wrapValue(invalid))
          const result = yield* editorSchema(schema).pipe(Effect.result)
          expect(Result.isFailure(result)).toBe(true)
          if (Result.isFailure(result)) expect(result.failure.code).toBe("unsupported-schema")
        }))
    }
  }

  for (const [name, branch, overlap, exclusive] of [
    ["string", Schema.String, "text", null],
    ["object", Schema.Struct({ item: Schema.String }), { item: "text" }, "text"],
    ["array", Schema.Array(Schema.String), ["text"], "text"]
  ] as const) {
    for (const [shape, wrapSchema, wrapValue] of [
      ["root", (schema: ContextFreeCodec) => schema, (value: Schema.Json) => value],
      ["nested object", (schema: ContextFreeCodec) => Schema.Struct({ choice: schema }), (value: Schema.Json) => ({ choice: value })],
      ["nested tuple", (schema: ContextFreeCodec) => Schema.Tuple([schema]), (value: Schema.Json) => [value]]
    ] as const) {
      it.effect(`rejects approximate JSON/${name} oneOf inside ${shape}`, () =>
        Effect.gen(function*() {
          const schema = wrapSchema(Schema.Union([Schema.Json, branch], { mode: "oneOf" }))
          yield* reject(schema, wrapValue(overlap))
          yield* roundtrip(schema, wrapValue(exclusive))
          const result = yield* editorSchema(schema).pipe(Effect.result)
          expect(Result.isFailure(result)).toBe(true)
          if (Result.isFailure(result)) expect(result.failure.code).toBe("unsupported-schema")
        }))
    }
  }

  for (const [name, branch] of [
    ["object property", Schema.Struct({ value: Schema.Json })],
    ["array element", Schema.Array(Schema.Json)],
    ["tuple element", Schema.Tuple([Schema.Json])],
    ["record value", Schema.Record(Schema.String, Schema.Json)],
    ["named reference", Schema.Struct({ value: Schema.Json }).annotate({ identifier: "JsonBranch" })],
    ["suspended reference", Schema.suspend(() => Schema.Struct({ value: Schema.Json }))],
    ["anyOf member", Schema.Union([Schema.Struct({ value: Schema.Json }), Schema.Boolean])]
  ] as const) {
    it.effect(`rejects oneOf approximation inherited through ${name}`, () =>
      Effect.gen(function*() {
        const result = yield* editorSchema(Schema.Union([branch, Schema.String], { mode: "oneOf" })).pipe(Effect.result)
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) expect(result.failure.code).toBe("unsupported-schema")
      }))
  }

  it.effect("rejects oneOf approximation behind a recursive named reference", () =>
    Effect.gen(function*() {
      const recursive: ContextFreeCodec = Schema.suspend(() => Schema.Struct({ next: Schema.optional(recursive), value: Schema.Json }))
        .annotate({ identifier: "RecursiveJsonBranch" })
      const schema = Schema.Union([recursive, Schema.String], { mode: "oneOf" })
      yield* roundtrip(schema, { value: null, next: { value: "text" } })
      const result = yield* editorSchema(schema).pipe(Effect.result)
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure.code).toBe("unsupported-schema")
    }))

  for (const [name, wrap] of [
    ["root", (schema: ContextFreeCodec) => schema],
    ["object", (schema: ContextFreeCodec) => Schema.Struct({ value: schema })],
    ["nested object", (schema: ContextFreeCodec) => Schema.Struct({ inner: Schema.Struct({ value: schema }) })],
    ["tuple", (schema: ContextFreeCodec) => Schema.Tuple([schema])],
    ["array", (schema: ContextFreeCodec) => Schema.Array(Schema.Struct({ value: schema }))],
    ["record", (schema: ContextFreeCodec) => Schema.Record(Schema.String, Schema.Struct({ value: schema }))],
    ["named reference", (schema: ContextFreeCodec) => Schema.Struct({ value: schema }).annotate({ identifier: "OptionalUndefined" })],
    ["suspended reference", (schema: ContextFreeCodec) => Schema.suspend(() => Schema.Struct({ value: schema }))],
    ["anyOf", (schema: ContextFreeCodec) => Schema.Union([Schema.Struct({ value: schema }), Schema.String])],
    ["oneOf", (schema: ContextFreeCodec) => Schema.Union([Schema.Struct({ value: schema }), Schema.Struct({ value: Schema.Null })], { mode: "oneOf" })],
    ["optional nested object", (schema: ContextFreeCodec) => Schema.Struct({ inner: Schema.optional(Schema.Struct({ value: schema })) })]
  ] as const) {
    it.effect(`rejects standalone optional encoded Undefined inside ${name}`, () =>
      Effect.gen(function*() {
        const schema = wrap(Schema.optionalKey(Schema.Undefined))
        const result = yield* editorSchema(schema).pipe(Effect.result)
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) expect(result.failure.code).toBe("unsupported-schema")
      }))
  }

  it.effect("distinguishes missing optional Undefined fields from explicit null and oneOf null branches", () =>
    Effect.gen(function*() {
      const optional = Schema.Struct({ value: Schema.optionalKey(Schema.Undefined) })
      yield* roundtrip(optional, {})
      yield* reject(optional, { value: null })
      yield* reject(optional, { value: undefined })
      const union = Schema.Union([optional, Schema.Struct({ value: Schema.Null })], { mode: "oneOf" })
      yield* roundtrip(union, {})
      yield* roundtrip(union, { value: null })
      for (const schema of [optional, union]) {
        const result = yield* editorSchema(schema).pipe(Effect.result)
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) expect(result.failure.code).toBe("unsupported-schema")
      }
    }))

  it.effect("keeps Undefined union omission, ordinary optional fields and encoded null transformations faithful", () =>
    Effect.gen(function*() {
      const nullToUndefined = Schema.Null.pipe(Schema.decodeTo(Schema.Undefined, {
        decode: SchemaGetter.transform(() => undefined), encode: SchemaGetter.transform(() => null)
      }))
      const schema = Schema.Struct({
        empty: Schema.optional(Schema.Undefined), label: Schema.optional(Schema.String),
        exact: Schema.optionalKey(Schema.String), nullable: Schema.optionalKey(Schema.Union([Schema.Undefined, Schema.Null])),
        decoded: Schema.optionalKey(nullToUndefined)
      })
      expect((yield* editorSchema(schema)).schema).toMatchObject({ properties: {
        empty: { not: {} }, label: { anyOf: [{ type: "string" }] }, exact: { type: "string" },
        nullable: { anyOf: [{ type: "null" }] }, decoded: { type: "null" }
      } })
      yield* roundtrip(schema, {})
      expect(yield* decodeJson(schema, { nullable: null, decoded: null })).toEqual({ nullable: null, decoded: undefined })
      expect(yield* Schema.encodeUnknownEffect(schema)({ nullable: null, decoded: undefined })).toEqual({ nullable: null, decoded: null })
      for (const key of ["empty", "label", "exact"]) yield* reject(schema, { [key]: null })
      yield* roundtrip(Schema.Null, null)
      expect((yield* editorSchema(Schema.Null)).schema).toEqual({ type: "null" })
    }))

  it.effect("rejects optional Void and unmarked Undefined unions without publishing null", () =>
    Effect.gen(function*() {
      for (const schema of [
        Schema.optionalKey(Schema.Void), Schema.optional(Schema.Void),
        Schema.Union([Schema.Undefined, Schema.Null]),
        Schema.Struct({ value: Schema.optional(Schema.Union([Schema.Undefined, Schema.Null])) })
      ]) {
        const result = yield* editorSchema(schema).pipe(Effect.result)
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) expect(result.failure.code).toBe("unsupported-schema")
      }
    }))

  it.effect("keeps default JSON unions and exact primitive oneOf descriptors supported", () =>
    Effect.gen(function*() {
      for (const branch of [Schema.String, Schema.Struct({ item: Schema.String }), Schema.Array(Schema.String)]) {
        const schema = Schema.Union([Schema.Json, branch])
        expect((yield* editorSchema(schema)).schema).toMatchObject({ anyOf: expect.any(Array) })
        for (const value of [null, "text", { item: "text" }, ["text"]]) yield* roundtrip(schema, value)
      }
      const exact = Schema.Union([Schema.String, Schema.Literal("overlap")], { mode: "oneOf" })
      expect((yield* editorSchema(exact)).schema).toMatchObject({ oneOf: [{ type: "string" }, { enum: ["overlap"] }] })
      yield* roundtrip(exact, "text")
      yield* reject(exact, "overlap")
      const sibling = Schema.Struct({ choice: exact, metadata: Schema.Json })
      expect((yield* editorSchema(sibling)).schema).toMatchObject({ properties: { choice: { oneOf: expect.any(Array) }, metadata: {} } })
      yield* roundtrip(sibling, { choice: "text", metadata: [null] })
      yield* reject(sibling, { choice: "overlap", metadata: [null] })
    }))

  it.effect("keeps primitive array uniqueness and length constraints representable", () =>
    Effect.gen(function*() {
      for (const [schema, expected] of [
        [Schema.Array(Schema.String).check(Schema.isUnique(), Schema.isMinLength(2), Schema.isMaxLength(3)),
          { type: "array", uniqueItems: true, minItems: 2, allOf: [{ minItems: 0, maxItems: 3 }] }],
        [Schema.Array(Schema.String).check(Schema.isUnique().and(Schema.isBetweenLength(2, 3))),
          { type: "array", allOf: [{ uniqueItems: true }, { minItems: 2, maxItems: 3 }] }]
      ] as const) {
        expect((yield* editorSchema(schema)).schema).toMatchObject(expected)
        yield* roundtrip(schema, ["1", "2"])
        for (const value of [[], ["1"], ["1", "1"], ["1", "2", "3", "4"]]) yield* reject(schema, value)
      }
    }))

  it.effect("preserves structural length checks over transformed elements", () =>
    Effect.gen(function*() {
      const count = Schema.Literals(["1", "2", "3"]).pipe(Schema.decodeTo(Schema.Finite, {
        decode: SchemaGetter.transform(Number), encode: SchemaGetter.transform((value) => String(value) as "1" | "2" | "3")
      }))
      for (const [check, expected, invalid] of [
        [Schema.isMinLength(2), { minItems: 2 }, ["1"]],
        [Schema.isMaxLength(2), { maxItems: 2 }, ["1", "2", "3"]],
        [Schema.isBetweenLength(2, 2), { minItems: 2, maxItems: 2 }, ["1"]],
        [Schema.isMinLength(2).and(Schema.isMaxLength(2)), { allOf: [{ minItems: 2 }, { maxItems: 2 }] }, ["1"]]
      ] as const) {
        const schema = Schema.Array(count).check(check)
        expect((yield* editorSchema(schema)).schema).toMatchObject(expected)
        yield* roundtrip(schema, ["1", "2"])
        yield* roundtrip(schema, ["1", "1"])
        yield* reject(schema, invalid)
      }
    }))

  it.effect("rejects transformed uniqueness even when annotated as structural", () =>
    Effect.gen(function*() {
      const element = (encoded: "left" | "right") => Schema.Literal(encoded).pipe(Schema.decodeTo(Schema.Literal(1), {
        decode: SchemaGetter.transform(() => 1 as const), encode: SchemaGetter.transform(() => encoded)
      }))
      const schema = Schema.Tuple([element("left"), element("right")]).check(Schema.isUnique({ "~structural": true }))
      yield* reject(schema, ["left", "right"])
      const result = yield* editorSchema(schema).pipe(Effect.result)
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure.code).toBe("unsupported-schema")
    }))

  it.effect("roundtrips every definition, configuration, decision and run contract", () =>
    Effect.gen(function*() {
      for (const [schema, value] of [
        [DefinitionReference, reference], [CredentialReference, credential], [IntegrationConfiguration, integration],
        [IntegrationDescriptor, descriptors[0]], [TriggerDescriptor, descriptors[1]], [ActionDescriptor, descriptors[2]], [RoutineDescriptor, descriptors[3]],
        [Catalog, { schemaVersion: 1, kind: "catalog", definitions: descriptors }], [ProcessDefinition, process],
        [RoutineConfiguration, configuration], [InvocationAuthority, authority], [AutomationRun, run],
        [JevDecisionRequest, { schemaVersion: 1, kind: "jev-request", provider: "opencode-zen", model: "jev", version: "1.13", configuration: configurationReference, input: run.input, outcomes: ["send", "ignore"], data: { text: "input" } }],
        [JevDecisionResult, { schemaVersion: 1, kind: "selected", outcomeId: "send", data: { reason: "matches" } }],
        [JevDecisionResult, { schemaVersion: 1, kind: "abstained", reason: "insufficient information" }]
      ] satisfies ReadonlyArray<readonly [ContextFreeCodec, unknown]>) yield* roundtrip(schema, value)
      expectTypeOf<typeof RoutineConfiguration.Type.reference>().toEqualTypeOf<{ readonly routineId: string; readonly revision: number }>()
    }))

  it.effect("roundtrips all run states and actual action result/error variants", () =>
    Effect.gen(function*() {
      for (const state of [
        { kind: "queued" }, { kind: "running" }, { kind: "succeeded", result: { delivered: true } },
        { kind: "unresolved", reason: "abstained" }, { kind: "failed", error: { code: "delivery", message: "failed", details: { count: 1 } } },
        { kind: "cancelled", reason: "cancelled by owner" }
      ]) yield* roundtrip(AutomationRun, { ...run, state })
      for (const outcome of [
        { kind: "planned", arguments: { recipient: "owner" } }, { kind: "succeeded", result: { sent: true } },
        { kind: "failed", error: { code: "provider", message: "failed", details: { status: 503 } } }, { kind: "skipped", reason: "abstained" }
      ]) yield* roundtrip(ActionOutcome, { ...outcome, stepId: "send", action: reference })
    }))

  it.effect("rejects unsupported contract versions, missing fields, invalid discriminants and non-JSON payloads", () =>
    Effect.gen(function*() {
      for (const [schema, value] of [[IntegrationConfiguration, integration], [ProcessDefinition, process], [RoutineConfiguration, configuration], [InvocationAuthority, authority], [AutomationRun, run]] satisfies ReadonlyArray<readonly [ContextFreeCodec, Record<string, unknown>]>) {
        yield* reject(schema, { ...value, schemaVersion: 2 })
        yield* reject(schema, { ...value, kind: "unknown" })
        yield* reject(schema, { schemaVersion: 1, kind: value["kind"] })
      }
      for (const value of [undefined, Number.NaN, Infinity, 1n, nonJsonDate, () => "value", Symbol("value"), new Map()]) {
        yield* reject(IntegrationConfiguration, { ...integration, configuration: value })
      }
      yield* reject(RunState, { kind: "failed", result: {} })
      yield* reject(RunState, { kind: "queued", result: {} })
      yield* reject(ActionOutcome, { kind: "succeeded", stepId: "send", action: reference, error: { code: "error", message: "fail" } })
      yield* reject(JevDecisionResult, { schemaVersion: 1, kind: "abstained", reason: "unsure", outcomeId: "send" })
      yield* reject(JevDecisionResult, { schemaVersion: 1, kind: "selected", data: {} })
    }))

  it.effect("pins positive definition versions separately from routine configuration revisions", () =>
    Effect.gen(function*() {
      for (const version of [0, -1, 1.5, "latest", undefined]) yield* reject(DefinitionReference, { id: reference.id, version })
      yield* reject(DefinitionReference, { id: "unnamespaced", version: 1 })
      yield* reject(RoutineConfiguration, { ...configuration, reference: { routineId: "personal", revision: 0 } })
      yield* roundtrip(RoutineConfiguration, { ...configuration, reference: { routineId: "personal", revision: 99 }, template: { ...reference, version: 7 } })
    }))

  it.effect("accepts only references in designated credential records without inspecting ordinary application strings", () =>
    Effect.gen(function*() {
      yield* roundtrip(IntegrationConfiguration, integration)
      yield* roundtrip(IntegrationConfiguration, { ...integration, configuration: { text: "password=ordinary-example" } })
      yield* reject(IntegrationConfiguration, { ...integration, credentials: { account: "inline-token" } })
      yield* reject(IntegrationConfiguration, { ...integration, credentials: { account: { ...credential, value: "inline-token" } } })
    }))

  it.effect("describes encoded constrained, optional and union fields without accepting decoded values", () =>
    Effect.gen(function*() {
      const schema = Schema.Struct({
        count: Schema.Literals(["4", "5"]).pipe(Schema.decodeTo(Schema.Finite, { decode: SchemaGetter.transform(Number), encode: SchemaGetter.transform((value) => String(value) as "4" | "5") })), note: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
        choice: Schema.Union([Schema.Literal("skip"), Schema.Struct({ enabled: Schema.Boolean })])
      })
      const descriptor = yield* editorSchema(schema)
      expect(descriptor.schema).toMatchObject({ type: "object", required: ["count", "choice"], additionalProperties: false, properties: { count: { enum: ["4", "5"] } } })
      const properties = (descriptor.schema as Record<string, Schema.Json>)["properties"] as Record<string, Schema.Json>
      expect(properties["note"]).toMatchObject({ anyOf: [{ type: "string", minLength: 1 }] })
      expect(properties["choice"]).toMatchObject({ anyOf: [{ enum: ["skip"] }, { type: "object", properties: { enabled: { type: "boolean" } } }] })
      yield* roundtrip(schema, { count: "4", choice: "skip" })
      yield* roundtrip(schema, { count: "4", note: "ok", choice: { enabled: true } })
      yield* reject(schema, { count: 4, choice: "skip" })
      yield* reject(schema, { count: "4", note: null, choice: "skip" })
      yield* reject(schema, { count: "4", note: "", choice: "skip" })
      const contractDescriptor = yield* editorSchema(ProcessDefinition)
      expect(contractDescriptor.schema).toMatchObject({ properties: { schemaVersion: { enum: [1] }, kind: { enum: ["process"] } }, required: expect.arrayContaining(["schemaVersion", "kind", "trigger", "actions"]) })
    }))
})
