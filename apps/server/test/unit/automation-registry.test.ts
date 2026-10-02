import { it } from "@effect/vitest"
import { Effect, Result, Schema, SchemaGetter, Context } from "effect"
import { describe, expect, expectTypeOf, vi } from "vitest"
import { defineAction, defineIntegration, defineTrigger, editorSchema } from "@expand/contracts/automation"
import type { ContextFreeCodec, FieldPath } from "@expand/contracts/automation"
import { AutomationRegistry } from "@expand/server/automation/registry"
import {
  makeSampleExtension, sampleAuthority, sampleConfiguration, sampleIntegration, SampleArguments, SampleCount, SampleIntegrationConfiguration,
  SamplePayload, SampleResult, sampleRoutine, sampleTrigger
} from "../fixtures/automation-sample-extension"

type Mutable<T> = T extends object ? { -readonly [Key in keyof T]: Mutable<T[Key]> } : T
const cloneConfiguration = (): Mutable<typeof sampleConfiguration> => structuredClone(sampleConfiguration) as Mutable<typeof sampleConfiguration>
const invocation = { configuration: sampleConfiguration, stepId: "send", triggerPayload: { subject: "hello", count: "3" }, mode: "live" as const }
const emptyExtension = { integrations: [], triggers: [], actions: [], routines: [] }
const failCode = Effect.fn("Test.failCode")(function*<A>(effect: Effect.Effect<A, { readonly code: string }>, code: string) {
  const result = yield* effect.pipe(Effect.result)
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result)) expect(result.failure.code).toBe(code)
})

describe("trusted automation registry", () => {
  for (const templatesInstalled of [false, true]) {
    for (const operation of ["validate", "resolve", "invoke"] as const) {
      it.effect(`${operation}s template-free custom configurations with templates installed ${templatesInstalled}`, () =>
        Effect.gen(function*() {
          const handler = vi.fn((args: typeof SampleArguments.Type) => Effect.succeed({ summary: args.message, total: args.count }))
          const registry = new AutomationRegistry()
          const sample = makeSampleExtension(handler)
          yield* registry.register({ ...sample.extension, routines: templatesInstalled ? sample.extension.routines : [] })
          const configuration = cloneConfiguration()
          Reflect.deleteProperty(configuration, "template")
          configuration.configuration = { message: "custom", count: "4" }
          configuration.process.actions["triggered"]![0]!.bindings = {
            message: { kind: "field", source: "configuration", path: ["message"] },
            count: { kind: "field", source: "configuration", path: ["count"] }
          }
          if (operation === "validate") expect(yield* registry.validateConfiguration(configuration)).toEqual(configuration)
          if (operation === "resolve") {
            const resolved = yield* registry.resolveSelectedActions(configuration, invocation.triggerPayload)
            expect(resolved.selection.kind).toBe("selected")
            expect(resolved.actions.map((action) => action.arguments)).toEqual([{ message: "custom", count: "4" }])
          }
          if (operation === "invoke") {
            expect(yield* registry.invokeAction({ ...invocation, configuration }, sampleAuthority)).toEqual({ summary: "custom", total: 4 })
            expect(handler).toHaveBeenCalledTimes(1)
            expect(handler.mock.calls[0]?.[0]).toEqual({ message: "custom", count: 4 })
          } else expect(handler).not.toHaveBeenCalled()
        }))
    }

    it.effect(`validates custom inputs and authority before handlers with templates installed ${templatesInstalled}`, () =>
      Effect.gen(function*() {
        const handler = vi.fn(() => Effect.succeed({ summary: "ok", total: 1 }))
        const registry = new AutomationRegistry()
        const sample = makeSampleExtension(handler)
        yield* registry.register({ ...sample.extension, routines: templatesInstalled ? sample.extension.routines : [] })
        const configuration = cloneConfiguration()
        Reflect.deleteProperty(configuration, "template")
        configuration.configuration = { custom: true }
        yield* registry.validateConfiguration(configuration)
        for (const mutate of [
          (config: Mutable<typeof sampleConfiguration>) => { config.configuration = { invalid: undefined } as unknown as Schema.Json },
          (config: Mutable<typeof sampleConfiguration>) => { config.process.trigger.configuration = { label: 2 } },
          (config: Mutable<typeof sampleConfiguration>) => { config.integrations[0]!.configuration = { mailbox: 1 } },
          (config: Mutable<typeof sampleConfiguration>) => { config.process.actions["triggered"]![0]!.bindings["count"] = { kind: "literal", value: 3 } },
          (config: Mutable<typeof sampleConfiguration>) => { config.process.actions["triggered"]![0]!.bindings["message"] = { kind: "literal", value: "" } }
        ]) {
          const invalid = structuredClone(configuration)
          mutate(invalid)
          yield* failCode(registry.invokeAction({ ...invocation, configuration: invalid }, sampleAuthority), "invalid-contract")
        }
        const missing = structuredClone(configuration)
        missing.process.actions["triggered"]![0]!.action.version = 99
        yield* failCode(registry.invokeAction({ ...invocation, configuration: missing }, sampleAuthority), "missing-definition")
        yield* failCode(registry.invokeAction({ ...invocation, configuration, triggerPayload: { subject: "hello", count: 3 } }, sampleAuthority), "invalid-contract")
        for (const authority of [
          { ...sampleAuthority, scope: { ...sampleAuthority.scope, ownerId: "other" } },
          { ...sampleAuthority, configuration: { ...sampleAuthority.configuration, revision: 99 } },
          { ...sampleAuthority, integrationIds: [] }, { ...sampleAuthority, actionGrants: [] },
          { ...sampleAuthority, actionGrants: [{ action: { id: "sample:send", version: 2 }, integrationId: "mail", capabilities: ["send"] }] },
          { ...sampleAuthority, actionGrants: [{ action: { id: "sample:send", version: 1 }, integrationId: "mail", capabilities: [] }] }
        ]) yield* failCode(registry.invokeAction({ ...invocation, configuration }, authority), "denied")
        yield* failCode(registry.invokeAction({ ...invocation, configuration }, undefined), "invalid-contract")
        const step = configuration.process.actions["triggered"]![0]!
        configuration.process = { ...configuration.process,
          decision: { kind: "jev", provider: "opencode-zen", model: "jev", version: "1.13", outcomes: ["send"] }, actions: { send: [step] }
        }
        const decision = { schemaVersion: 1, kind: "abstained", reason: "unsure" }
        expect(yield* registry.resolveSelectedActions(configuration, invocation.triggerPayload, decision)).toEqual({
          selection: { kind: "unresolved", reason: "unsure", actions: [] }, actions: []
        })
        yield* failCode(registry.invokeAction({ ...invocation, configuration, decision }, sampleAuthority), "unresolved-selection")
        expect(handler).not.toHaveBeenCalled()
      }))
  }

  it.effect("still rejects present unknown, malformed and codec-invalid templates before handlers", () =>
    Effect.gen(function*() {
      const handler = vi.fn(() => Effect.succeed({ summary: "ok", total: 1 }))
      const registry = new AutomationRegistry()
      yield* registry.register(makeSampleExtension(handler).extension)
      yield* failCode(registry.invokeAction({ ...invocation, configuration: { ...sampleConfiguration, template: { ...sampleRoutine.definition, version: 99 } } }, sampleAuthority), "missing-definition")
      for (const template of [null, {}, { ...sampleRoutine.definition, version: 0 }]) {
        yield* failCode(registry.invokeAction({ ...invocation, configuration: { ...sampleConfiguration, template } }, sampleAuthority), "invalid-contract")
      }
      yield* failCode(registry.invokeAction({ ...invocation, configuration: { ...sampleConfiguration, configuration: { custom: true } } }, sampleAuthority), "invalid-contract")
      expect(handler).not.toHaveBeenCalled()
    }))

  it.effect("captures both versions' handlers and codecs when reusing builder input", () =>
    Effect.gen(function*() {
      const firstHandler = vi.fn((args: typeof SampleArguments.Type) => Effect.succeed({ summary: `first:${args.message}`, total: args.count }))
      const secondHandler = vi.fn((args: typeof SampleArguments.Type) => Effect.succeed({ summary: `second:${args.message}`, total: args.count }))
      const input = {
        definition: { id: "sample:send", version: 1 }, title: "Reusable action", integration: sampleIntegration.definition,
        capabilities: ["send"], argumentsSchema: SampleArguments, resultSchema: SampleResult,
        integrationConfigurationSchema: SampleIntegrationConfiguration, handler: firstHandler
      }
      const first = defineAction(input)
      input.definition = { ...input.definition, version: 2 }
      input.handler = secondHandler
      input.argumentsSchema = Schema.Struct({ message: Schema.String.check(Schema.isMinLength(2)), count: SampleCount })
      const second = defineAction(input)
      input.argumentsSchema = Schema.Struct({ message: Schema.String.check(Schema.isMinLength(100)), count: SampleCount })
      input.resultSchema = Schema.Struct({ summary: Schema.String.check(Schema.isMinLength(100)), total: Schema.Finite })
      input.integrationConfigurationSchema = Schema.Struct({ mailbox: Schema.String.check(Schema.isMinLength(100)) })
      input.handler = vi.fn(() => Effect.succeed({ summary: "mutated", total: 0 }))
      const registry = new AutomationRegistry()
      yield* registry.register({ ...makeSampleExtension().extension, actions: [first, second] })
      expect(yield* registry.invokeAction({ ...invocation, triggerPayload: { subject: "x", count: "3" } }, sampleAuthority)).toEqual({ summary: "first:x", total: 3 })
      const configuration = cloneConfiguration()
      configuration.process.actions["triggered"]![0]!.action.version = 2
      const authority = { ...sampleAuthority, actionGrants: [{ ...sampleAuthority.actionGrants[0]!, action: second.definition }] }
      expect(yield* registry.invokeAction({ ...invocation, configuration }, authority)).toEqual({ summary: "second:hello", total: 3 })
      expect(firstHandler).toHaveBeenCalledTimes(1)
      expect(secondHandler).toHaveBeenCalledTimes(1)
      yield* failCode(registry.invokeAction({ ...invocation, configuration, triggerPayload: { subject: "x", count: "3" } }, authority), "invalid-contract")
      expect(secondHandler).toHaveBeenCalledTimes(1)
      expect(input.handler).not.toHaveBeenCalled()
    }))

  it.effect("rejects a concurrent duplicate registration without duplicate catalog entries", () =>
    Effect.gen(function*() {
      const registry = new AutomationRegistry()
      const extension = { ...emptyExtension, integrations: Array.from({ length: 100 }, (_, index) =>
        defineIntegration({ ...sampleIntegration, definition: { id: `concurrent:item-${index}`, version: 1 } })) }
      const results = yield* Effect.all([registry.register(extension).pipe(Effect.result), registry.register(extension).pipe(Effect.result)], { concurrency: "unbounded" })
      expect(results.filter(Result.isSuccess)).toHaveLength(1)
      const failures = results.filter(Result.isFailure)
      expect(failures.map((result) => result.failure.code)).toEqual(["duplicate-definition"])
      expect(registry.catalog().definitions).toHaveLength(100)
    }))

  it.effect("retains concurrent distinct definitions and every catalog reference", () =>
    Effect.gen(function*() {
      const registry = new AutomationRegistry()
      const integrations = ["left", "right"].map((lane) => Array.from({ length: 100 }, (_, index) =>
        defineIntegration({ ...sampleIntegration, definition: { id: `concurrent:${lane}-${index}`, version: 1 } })))
      yield* Effect.all(integrations.map((definitions) => registry.register({ ...emptyExtension, integrations: definitions })), { concurrency: "unbounded" })
      expect(registry.catalog().definitions).toHaveLength(200)
      for (const definitions of integrations) {
        yield* registry.register({ ...emptyExtension, triggers: definitions.map((integration) => defineTrigger({
          ...sampleTrigger, definition: { id: `${integration.definition.id}-trigger`, version: 1 }, integration: integration.definition
        })) })
      }
      expect(registry.catalog().definitions).toHaveLength(400)
      expect(new Set(registry.catalog().definitions.map((entry) => `${entry.definition.id}@${entry.definition.version}`)).size).toBe(400)
    }))

  it.effect("rejects incompatible integration configuration codecs atomically", () =>
    Effect.gen(function*() {
      const registry = new AutomationRegistry()
      yield* registry.register(makeSampleExtension().extension)
      const before = registry.catalog()
      const mismatched = defineAction({
        ...makeSampleExtension().action, definition: { id: "sample:incompatible", version: 1 },
        integrationConfigurationSchema: Schema.Struct({ endpoint: Schema.String }),
        handler: (_args, config) => Effect.succeed({ summary: config.endpoint, total: 1 })
      })
      yield* failCode(registry.register({ ...emptyExtension,
        integrations: [defineIntegration({ ...sampleIntegration, definition: { id: "sample:rollback", version: 1 } })], actions: [mismatched]
      }), "invalid-reference")
      expect(registry.catalog()).toEqual(before)
      yield* registry.register({ ...emptyExtension, integrations: [defineIntegration({ ...sampleIntegration, definition: { id: "sample:rollback", version: 1 } })] })
    }))

  it.effect("rejects different decoded integration types even with identical encoded descriptors", () =>
    Effect.gen(function*() {
      const mailbox = Schema.Literals(["inbox", "outbox"])
      const encoded = Schema.Struct({ mailbox })
      const decoded = Schema.Struct({ mailbox: mailbox.pipe(Schema.decodeTo(Schema.Literals([1, 2]), {
        decode: SchemaGetter.transform((value) => value === "inbox" ? 1 : 2),
        encode: SchemaGetter.transform((value) => value === 1 ? "inbox" as const : "outbox" as const)
      })) })
      expect(yield* editorSchema(encoded)).toEqual(yield* editorSchema(decoded))
      const integration = defineIntegration({ ...sampleIntegration, configurationSchema: encoded })
      const action = defineAction({ ...makeSampleExtension().action, integrationConfigurationSchema: decoded,
        handler: (_args, config) => {
          expectTypeOf(config.mailbox).toEqualTypeOf<1 | 2>()
          return Effect.succeed({ summary: "decoded", total: config.mailbox })
        }
      })
      const registry = new AutomationRegistry()
      yield* failCode(registry.register({ ...emptyExtension, integrations: [integration], actions: [action] }), "invalid-reference")
      expect(registry.catalog().definitions).toEqual([])
    }))


  it.effect("decodes shared integration codecs into the handler configuration type", () =>
    Effect.gen(function*() {
      const configurationSchema = Schema.Struct({ mailbox: Schema.Literals(["inbox", "outbox"]).pipe(Schema.decodeTo(Schema.Finite, {
        decode: SchemaGetter.transform((value) => value === "inbox" ? 1 : 2),
        encode: SchemaGetter.transform((value) => value === 1 ? "inbox" as const : "outbox" as const)
      })) })
      const integration = defineIntegration({ ...sampleIntegration, configurationSchema })
      const handler = vi.fn((args: typeof SampleArguments.Type, config: typeof configurationSchema.Type) => Effect.succeed({ summary: "shared", total: args.count + config.mailbox }))
      const action = defineAction({ ...makeSampleExtension().action, integrationConfigurationSchema: configurationSchema,
        handler: (args, config) => {
          expectTypeOf(config.mailbox).toEqualTypeOf<number>()
          return handler(args, config)
        }
      })
      const registry = new AutomationRegistry()
      yield* registry.register({ ...makeSampleExtension().extension, integrations: [integration], actions: [action] })
      expect(yield* registry.invokeAction(invocation, sampleAuthority)).toEqual({ summary: "shared", total: 4 })
      expect(handler.mock.calls[0]?.[1]).toEqual({ mailbox: 1 })
    }))

  it.effect("rejects lossy encoded constraints and partial transformations without publishing definitions", () =>
    Effect.gen(function*() {
      const refined = Schema.Literals(["-1", "1"]).pipe(Schema.decodeTo(Schema.Finite.check(Schema.isGreaterThan(0)), {
        decode: SchemaGetter.transform(Number), encode: SchemaGetter.transform((value) => String(value) as "-1" | "1")
      }))
      for (const schema of [
        Schema.String.check(Schema.isPattern(/^HELLO$/i)), Schema.FiniteFromString, refined,
        Schema.String.check(Schema.makeFilter((value: string) => value === "only", { toJsonSchema: () => ({ type: "string" }) }))
      ]) {
        const registry = new AutomationRegistry()
        yield* failCode(registry.register({ ...emptyExtension, integrations: [sampleIntegration,
          defineIntegration({ ...sampleIntegration, definition: { id: "sample:lossy", version: 1 }, configurationSchema: schema })]
        }), "unsupported-schema")
        expect(registry.catalog().definitions).toEqual([])
        yield* registry.register({ ...emptyExtension, integrations: [sampleIntegration] })
      }
    }))

  it.effect("resolves inherited outcome names with absent and explicit own routes", () =>
    Effect.gen(function*() {
      const registry = new AutomationRegistry()
      yield* registry.register(makeSampleExtension().extension)
      for (const outcomeId of ["constructor", "toString", "__proto__"]) {
        for (const routed of [false, true]) {
          const configuration = cloneConfiguration()
          const step = configuration.process.actions["triggered"]![0]!
          configuration.process = { ...configuration.process,
            decision: { kind: "jev", provider: "opencode-zen", model: "jev", version: "1.13", outcomes: [outcomeId] },
            actions: routed ? { [outcomeId]: [step] } : {}
          }
          const resolved = yield* registry.resolveSelectedActions(configuration, invocation.triggerPayload,
            { schemaVersion: 1, kind: "selected", outcomeId, data: {} })
          expect(Array.isArray(resolved.selection.actions)).toBe(true)
          expect(resolved.actions.map((action) => action.stepId)).toEqual(routed ? ["send"] : [])
        }
      }
    }))

  it.effect("registers a separate public extension and invokes only one explicitly authorized action", () =>
    Effect.gen(function*() {
      const handler = vi.fn((args: typeof SampleArguments.Type, config: typeof SampleIntegrationConfiguration.Type) => Effect.succeed({ summary: `${config.mailbox}:${args.message}`, total: args.count }))
      const sample = makeSampleExtension(handler)
      expectTypeOf(sample.action.handler).parameter(0).toEqualTypeOf<typeof SampleArguments.Type>()
      expectTypeOf<typeof SampleArguments.Encoded>().toEqualTypeOf<{ readonly message: string; readonly count: typeof SampleCount.Encoded }>()
      expectTypeOf<typeof SamplePayload.Type>().toEqualTypeOf<{ readonly subject: string; readonly count: number }>()
      expectTypeOf<readonly ["subject"]>().toExtend<FieldPath<typeof SamplePayload.Encoded>>()
      expectTypeOf<readonly ["absent"]>().not.toExtend<FieldPath<typeof SamplePayload.Encoded>>()
      const registry = new AutomationRegistry()
      yield* registry.register(sample.extension)
      const catalog = registry.catalog()
      expect(catalog.definitions.map((entry) => entry.kind)).toEqual(["integration", "trigger", "action", "routine-template"])
      expect(catalog.definitions.every((entry) => !("handler" in entry) && !("invoke" in entry))).toBe(true)
      const resolved = yield* registry.resolveSelectedActions(sampleConfiguration, invocation.triggerPayload)
      expect(resolved.actions[0]?.arguments).toEqual({ message: "hello", count: "3" })
      expect(handler).not.toHaveBeenCalled()
      expect(yield* registry.invokeAction(invocation, sampleAuthority)).toEqual({ summary: "inbox:hello", total: 3 })
      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler.mock.calls[0]?.[0].count).toBe(3)
    }))

  it.effect("publishes finite numeric descriptors for every registered codec", () =>
    Effect.gen(function*() {
      const number = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThan(2))
      const configurationSchema = Schema.Struct({ value: number })
      const integration = defineIntegration({ definition: { id: "numeric:integration", version: 1 }, title: "Numeric", capabilities: [], configurationSchema })
      const trigger = defineTrigger({ definition: { id: "numeric:trigger", version: 1 }, title: "Numeric", integration: integration.definition,
        configurationSchema: Schema.Array(number), payloadSchema: Schema.Record(Schema.String, number) })
      const action = defineAction({ definition: { id: "numeric:action", version: 1 }, title: "Numeric", integration: integration.definition, capabilities: [],
        integrationConfigurationSchema: configurationSchema, argumentsSchema: Schema.Struct({ value: Schema.optional(number) }),
        resultSchema: Schema.Union([Schema.Number, Schema.Null]), handler: () => Effect.succeed(1) })
      const registry = new AutomationRegistry()
      yield* registry.register({ integrations: [integration], triggers: [trigger], actions: [action], routines: [] })
      const catalog = registry.catalog()
      expect(catalog.definitions).toHaveLength(3)
      expect(catalog.definitions[0]).toMatchObject({ configurationSchema: { schema: { properties: { value: { type: "number", minimum: 0, exclusiveMaximum: 2 } } } } })
      expect(catalog.definitions[1]).toMatchObject({ configurationSchema: { schema: { items: { type: "number", minimum: 0, exclusiveMaximum: 2 } } },
        payloadSchema: { schema: { additionalProperties: { type: "number", minimum: 0, exclusiveMaximum: 2 } } } })
      expect(catalog.definitions[2]).toMatchObject({ argumentsSchema: { schema: { properties: { value: { anyOf: [{ type: "number", minimum: 0, exclusiveMaximum: 2 }] } } } },
        resultSchema: { schema: { anyOf: [{ type: "number" }, { type: "null" }] } } })
    }))

  it.effect("keeps exact definition versions together and never falls back to latest", () =>
    Effect.gen(function*() {
      const registry = new AutomationRegistry()
      yield* registry.register(makeSampleExtension().extension)
      yield* registry.register({ ...emptyExtension, integrations: [defineIntegration({ ...sampleIntegration, definition: { ...sampleIntegration.definition, version: 2 } })] })
      expect(registry.catalog().definitions.filter((entry) => entry.definition.id === sampleIntegration.definition.id).map((entry) => entry.definition.version)).toEqual([1, 2])
      const configuration = cloneConfiguration()
      configuration.template = { ...sampleRoutine.definition, version: 2 }
      yield* failCode(registry.validateConfiguration(configuration), "missing-definition")
      configuration.template = { ...sampleRoutine.definition }
      configuration.process.trigger.definition = { ...sampleTrigger.definition, version: 2 }
      yield* failCode(registry.validateConfiguration(configuration), "missing-definition")
    }))

  it.effect("infers decoded handler values from public builder schemas and checks exact action grants across versions", () =>
    Effect.gen(function*() {
      const registry = new AutomationRegistry()
      yield* registry.register(makeSampleExtension().extension)
      const handler = vi.fn((args: typeof SampleArguments.Type) => Effect.succeed({ summary: args.message, total: args.count }))
      const versionTwo = defineAction({
        definition: { id: "sample:send", version: 2 }, title: "Second version", integration: sampleIntegration.definition,
        capabilities: ["send"], argumentsSchema: SampleArguments, resultSchema: SampleResult, integrationConfigurationSchema: SampleIntegrationConfiguration,
        handler: (args, config, context) => {
          expectTypeOf(args).toEqualTypeOf<typeof SampleArguments.Type>()
          expectTypeOf(config).toEqualTypeOf<typeof SampleIntegrationConfiguration.Type>()
          expectTypeOf(context.mode).toEqualTypeOf<"live" | "preview">()
          return handler(args)
        }
      })
      yield* registry.register({ ...emptyExtension, actions: [versionTwo] })
      const configuration = cloneConfiguration()
      configuration.process.actions["triggered"]![0]!.action.version = 2
      yield* failCode(registry.invokeAction({ ...invocation, configuration }, sampleAuthority), "denied")
      expect(handler).not.toHaveBeenCalled()
      const authority = { ...sampleAuthority, actionGrants: [{ action: versionTwo.definition, integrationId: "mail", capabilities: ["send"] }] }
      expect(yield* registry.invokeAction({ ...invocation, configuration }, authority)).toEqual({ summary: "hello", total: 3 })
      expect(handler).toHaveBeenCalledTimes(1)
      configuration.process.actions["triggered"]![0]!.action.version = 3
      yield* failCode(registry.validateConfiguration(configuration), "missing-definition")
    }))

  it.effect("retains registration metadata and returns catalog copies", () =>
    Effect.gen(function*() {
      const registry = new AutomationRegistry()
      const integration = { ...sampleIntegration, definition: { ...sampleIntegration.definition }, capabilities: [...sampleIntegration.capabilities] }
      yield* registry.register({ ...emptyExtension, integrations: [integration] })
      integration.definition.version = 9
      integration.capabilities.push("extra")
      const first = registry.catalog()
      expect(first.definitions[0]).toMatchObject({ definition: { version: 1 }, capabilities: ["send"] })
      const entry = first.definitions[0]
      if (entry?.kind === "integration") (entry.capabilities as Array<string>).push("catalog-mutation")
      expect(registry.catalog().definitions[0]).toMatchObject({ definition: { version: 1 }, capabilities: ["send"] })
    }))

  it.effect("rejects duplicate registration, references, capabilities and unsupported descriptors atomically", () =>
    Effect.gen(function*() {
      const registry = new AutomationRegistry()
      const sample = makeSampleExtension()
      yield* registry.register(sample.extension)
      const before = registry.catalog()
      const newIntegration = defineIntegration({ ...sampleIntegration, definition: { id: "sample:new", version: 1 } })
      yield* failCode(registry.register({ ...emptyExtension, integrations: [newIntegration, sampleIntegration] }), "duplicate-definition")
      expect(registry.catalog()).toEqual(before)
      for (const action of [
        { ...sample.action, definition: { id: "sample:bad", version: 1 }, integration: { id: "sample:missing", version: 1 } },
        { ...sample.action, definition: { id: "sample:bad", version: 1 }, capabilities: ["undeclared"] }
      ]) {
        yield* failCode(registry.register({ ...emptyExtension, integrations: [newIntegration], actions: [action] }), action.capabilities.includes("undeclared") ? "invalid-reference" : "missing-definition")
        expect(registry.catalog()).toEqual(before)
      }
      for (const schema of [Schema.BigInt, Schema.Unknown, Schema.String.check(Schema.makeFilter((value: string) => value.length % 2 === 0)), Schema.declare((value: unknown): value is string => typeof value === "string")]) {
        yield* failCode(registry.register({ ...emptyExtension, integrations: [newIntegration, defineIntegration({ ...newIntegration, definition: { id: "sample:unsupported", version: 1 }, configurationSchema: schema })] }), "unsupported-schema")
        expect(registry.catalog()).toEqual(before)
      }
    }))

  it.effect("rejects context-dependent codecs before any registration is retained", () =>
    Effect.gen(function*() {
      class Prefix extends Context.Service<Prefix, string>()("SamplePrefix") {}
      const contextual = Schema.String.pipe(Schema.decodeTo(Schema.String, {
        decode: SchemaGetter.transformEffect((value: string) => Prefix.pipe(Effect.map((prefix) => prefix + value))),
        encode: SchemaGetter.passthrough()
      }))
      expectTypeOf<typeof contextual.DecodingServices>().toEqualTypeOf<Prefix>()
      expectTypeOf<typeof contextual>().not.toExtend<ContextFreeCodec>()
      const registry = new AutomationRegistry()
      const forged = contextual as unknown as ContextFreeCodec
      yield* failCode(registry.register({ ...emptyExtension, integrations: [sampleIntegration, defineIntegration({ ...sampleIntegration, definition: { id: "sample:contextual", version: 1 }, configurationSchema: forged })] }), "unsupported-schema")
      expect(registry.catalog().definitions).toEqual([])
    }))

  for (const sufficientFirst of [false, true]) {
    it.effect(`authorizes overlapping grants with the sufficient grant first ${sufficientFirst}`, () =>
      Effect.gen(function*() {
        const handler = vi.fn((args: typeof SampleArguments.Type) => Effect.succeed({ summary: args.message, total: args.count }))
        const registry = new AutomationRegistry()
        yield* registry.register(makeSampleExtension(handler).extension)
        const sufficient = sampleAuthority.actionGrants[0]!
        const insufficient = { ...sufficient, capabilities: [] }
        const authority = { ...sampleAuthority, actionGrants: sufficientFirst ? [sufficient, insufficient] : [insufficient, sufficient] }
        const result = yield* registry.invokeAction(invocation, authority).pipe(Effect.result)
        expect(handler).toHaveBeenCalledTimes(1)
        expect(handler.mock.calls[0]?.[0]).toEqual({ message: "hello", count: 3 })
        expect(Result.isSuccess(result)).toBe(true)
        if (Result.isSuccess(result)) expect(result.success).toEqual({ summary: "hello", total: 3 })
      }))
  }

  it.effect("requires one complete matching grant without combining partial capabilities", () =>
    Effect.gen(function*() {
      const handler = vi.fn((args: typeof SampleArguments.Type) => Effect.succeed({ summary: args.message, total: args.count }))
      const sample = makeSampleExtension(handler)
      const capabilities = ["send", "audit"]
      const registry = new AutomationRegistry()
      yield* registry.register({ ...sample.extension,
        integrations: [defineIntegration({ ...sampleIntegration, capabilities })],
        actions: [defineAction({ ...sample.action, capabilities })]
      })
      const sufficient = { ...sampleAuthority.actionGrants[0]!, capabilities }
      const send = { ...sufficient, capabilities: ["send"] }
      const audit = { ...sufficient, capabilities: ["audit"] }
      for (const actionGrants of [
        [send], [send, audit], [audit, send],
        [send, { ...sufficient, action: { id: "sample:other", version: 1 } }],
        [send, { ...sufficient, action: { ...sufficient.action, version: 2 } }],
        [send, { ...sufficient, integrationId: "other" }]
      ]) {
        yield* failCode(registry.invokeAction(invocation, { ...sampleAuthority, actionGrants }), "denied")
        expect(handler).not.toHaveBeenCalled()
      }
      for (const actionGrants of [[send, sufficient], [sufficient, send]]) {
        expect(yield* registry.invokeAction(invocation, { ...sampleAuthority, actionGrants })).toEqual({ summary: "hello", total: 3 })
      }
      expect(handler).toHaveBeenCalledTimes(2)
    }))

  it.effect("requires matching host scope, routine revision, integration and exact action capability grants", () =>
    Effect.gen(function*() {
      const handler = vi.fn(() => Effect.succeed({ summary: "ok", total: 1 }))
      const registry = new AutomationRegistry()
      yield* registry.register(makeSampleExtension(handler).extension)
      const sufficient = sampleAuthority.actionGrants[0]!
      const actionGrants = [{ ...sufficient, capabilities: [] }, sufficient]
      for (const authority of [
        { ...sampleAuthority, actionGrants, scope: { ...sampleAuthority.scope, ownerId: "other" } },
        { ...sampleAuthority, actionGrants, scope: { ...sampleAuthority.scope, projectId: "other" } },
        { ...sampleAuthority, actionGrants, configuration: { ...sampleAuthority.configuration, routineId: "other" } },
        { ...sampleAuthority, actionGrants, configuration: { ...sampleAuthority.configuration, revision: 1 } },
        { ...sampleAuthority, actionGrants, integrationIds: [] },
        { ...sampleAuthority, actionGrants: [] },
        { ...sampleAuthority, actionGrants: [{ ...sufficient, action: { id: "sample:other", version: 1 } }] },
        { ...sampleAuthority, actionGrants: [{ action: { id: "sample:send", version: 2 }, integrationId: "mail", capabilities: ["send"] }] },
        { ...sampleAuthority, actionGrants: [{ action: { id: "sample:send", version: 1 }, integrationId: "other", capabilities: ["send"] }] },
        { ...sampleAuthority, actionGrants: [{ action: { id: "sample:send", version: 1 }, integrationId: "mail", capabilities: [] }] }
      ]) yield* failCode(registry.invokeAction(invocation, authority), "denied")
      yield* failCode(registry.invokeAction(invocation, undefined), "invalid-contract")
      yield* failCode(registry.invokeAction({ ...invocation, configuration: { ...sampleConfiguration, authority: sampleAuthority } }, sampleAuthority), "invalid-contract")
      expect(handler).not.toHaveBeenCalled()
    }))

  it.effect("validates every encoded input and binding before the handler", () =>
    Effect.gen(function*() {
      const handler = vi.fn(() => Effect.succeed({ summary: "ok", total: 1 }))
      const registry = new AutomationRegistry()
      yield* registry.register(makeSampleExtension(handler).extension)
      for (const mutate of [
        (config: Mutable<typeof sampleConfiguration>) => { config.configuration = { prefix: 1 } },
        (config: Mutable<typeof sampleConfiguration>) => { config.process.trigger.configuration = { label: 2 } },
        (config: Mutable<typeof sampleConfiguration>) => { config.integrations = [{ ...config.integrations[0]!, configuration: { mailbox: 1 } }] },
        (config: Mutable<typeof sampleConfiguration>) => { config.process.actions["triggered"]![0]!.bindings["count"] = { kind: "literal", value: 3 } },
        (config: Mutable<typeof sampleConfiguration>) => { config.process.actions["triggered"]![0]!.bindings["message"] = { kind: "literal", value: "" } }
      ]) {
        const config = cloneConfiguration()
        mutate(config)
        yield* failCode(registry.invokeAction({ ...invocation, configuration: config }, sampleAuthority), "invalid-contract")
      }
      yield* failCode(registry.invokeAction({ ...invocation, triggerPayload: { subject: "hi", count: 3 } }, sampleAuthority), "invalid-contract")
      yield* failCode(registry.invokeAction({ ...invocation, stepId: "absent" }, sampleAuthority), "invalid-reference")
      expect(handler).not.toHaveBeenCalled()
    }))

  it.effect("rejects missing or incompatible exact integration, trigger, template and action references", () =>
    Effect.gen(function*() {
      const registry = new AutomationRegistry()
      yield* registry.register(makeSampleExtension().extension)
      for (const mutate of [
        (config: Mutable<typeof sampleConfiguration>) => { config.template!.version = 99 },
        (config: Mutable<typeof sampleConfiguration>) => { config.process.trigger.definition.version = 99 },
        (config: Mutable<typeof sampleConfiguration>) => { config.process.actions["triggered"]![0]!.action.version = 99 },
        (config: Mutable<typeof sampleConfiguration>) => { config.integrations[0]!.definition.version = 99 }
      ]) {
        const configuration = cloneConfiguration()
        mutate(configuration)
        yield* failCode(registry.validateConfiguration(configuration), "missing-definition")
      }
      const configuration = cloneConfiguration()
      configuration.integrations = []
      yield* failCode(registry.validateConfiguration(configuration), "invalid-reference")
      const mismatched = cloneConfiguration()
      mismatched.process.trigger.integration.id = "other-instance"
      yield* failCode(registry.validateConfiguration(mismatched), "invalid-reference")
      yield* failCode(registry.validateConfiguration({ ...sampleConfiguration, integrations: [...sampleConfiguration.integrations, ...sampleConfiguration.integrations] }), "invalid-reference")
    }))

  it.effect("keeps abstention unresolved and preserves action order without invoking handlers", () =>
    Effect.gen(function*() {
      const handler = vi.fn(() => Effect.succeed({ summary: "ok", total: 1 }))
      const registry = new AutomationRegistry()
      yield* registry.register(makeSampleExtension(handler).extension)
      const configuration = cloneConfiguration()
      const action = configuration.process.actions["triggered"]![0]!
      configuration.process = { ...configuration.process, decision: { kind: "jev", provider: "opencode-zen", model: "jev", version: "1.13", outcomes: ["send", "ignore"] }, actions: { send: [{ ...action, id: "second" }, { ...action, id: "first" }], ignore: [] } }
      const abstained = { schemaVersion: 1, kind: "abstained", reason: "unsure" }
      const unresolved = yield* registry.resolveSelectedActions(configuration, invocation.triggerPayload, abstained)
      expect(unresolved).toEqual({ selection: { kind: "unresolved", reason: "unsure", actions: [] }, actions: [] })
      yield* failCode(registry.invokeAction({ ...invocation, configuration, decision: abstained }, sampleAuthority), "unresolved-selection")
      const selected = yield* registry.resolveSelectedActions(configuration, invocation.triggerPayload, { schemaVersion: 1, kind: "selected", outcomeId: "send", data: {} })
      expect(selected.actions.map((action) => action.stepId)).toEqual(["second", "first"])
      expect(handler).not.toHaveBeenCalled()
    }))

  it.effect("rejects invalid handler outputs and records typed handler failure", () =>
    Effect.gen(function*() {
      const invalid = new AutomationRegistry()
      yield* invalid.register(makeSampleExtension(() => Effect.succeed({ summary: "ok", total: Number.NaN })).extension)
      yield* failCode(invalid.invokeAction(invocation, sampleAuthority), "invalid-contract")
      const failed = new AutomationRegistry()
      yield* failed.register(makeSampleExtension(() => Effect.fail({ code: "sample-failure", message: "could not send", details: { attempts: 1 } })).extension)
      const failure = yield* failed.invokeAction(invocation, sampleAuthority).pipe(Effect.flip)
      expect(failure.code).toBe("handler-failed")
      expect(failure.failure).toEqual({ code: "sample-failure", message: "could not send", details: { attempts: 1 } })
      expectTypeOf<typeof SampleResult.Type>().toEqualTypeOf<{ readonly summary: string; readonly total: number }>()
    }))

  it.effect("emits encoded editor fields for transformed argument schemas", () =>
    Effect.gen(function*() {
      const descriptor = yield* editorSchema(SampleArguments)
      expect(descriptor.schema).toMatchObject({ type: "object", required: ["message", "count"], properties: { message: { type: "string", minLength: 1 }, count: { enum: ["1", "2", "3", "4", "5"] } }, additionalProperties: false })
      expect(yield* editorSchema(SampleIntegrationConfiguration)).toMatchObject({ schema: { properties: { mailbox: { minLength: 1 } } } })
    }))
})
