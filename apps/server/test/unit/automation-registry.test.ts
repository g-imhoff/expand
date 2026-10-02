import { it } from "@effect/vitest"
import { Effect, Result, Schema, SchemaGetter, Context } from "effect"
import { describe, expect, expectTypeOf, vi } from "vitest"
import { defineAction, defineIntegration, editorSchema } from "@expand/contracts/automation"
import type { ContextFreeCodec, FieldPath } from "@expand/contracts/automation"
import { AutomationRegistry } from "@expand/server/automation/registry"
import {
  makeSampleExtension, sampleAuthority, sampleConfiguration, sampleIntegration, SampleArguments, SampleIntegrationConfiguration,
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
  it.effect("registers a separate public extension and invokes only one explicitly authorized action", () =>
    Effect.gen(function*() {
      const handler = vi.fn((args: typeof SampleArguments.Type, config: typeof SampleIntegrationConfiguration.Type) => Effect.succeed({ summary: `${config.mailbox}:${args.message}`, total: args.count }))
      const sample = makeSampleExtension(handler)
      expectTypeOf(sample.action.handler).parameter(0).toEqualTypeOf<typeof SampleArguments.Type>()
      expectTypeOf<typeof SampleArguments.Encoded>().toEqualTypeOf<{ readonly message: string; readonly count: string }>()
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

  it.effect("requires matching host scope, routine revision, integration and exact action capability grants", () =>
    Effect.gen(function*() {
      const handler = vi.fn(() => Effect.succeed({ summary: "ok", total: 1 }))
      const registry = new AutomationRegistry()
      yield* registry.register(makeSampleExtension(handler).extension)
      for (const authority of [
        { ...sampleAuthority, scope: { ...sampleAuthority.scope, ownerId: "other" } },
        { ...sampleAuthority, scope: { ...sampleAuthority.scope, projectId: "other" } },
        { ...sampleAuthority, configuration: { ...sampleAuthority.configuration, routineId: "other" } },
        { ...sampleAuthority, configuration: { ...sampleAuthority.configuration, revision: 1 } },
        { ...sampleAuthority, integrationIds: [] },
        { ...sampleAuthority, actionGrants: [] },
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
        (config: Mutable<typeof sampleConfiguration>) => { config.template.version = 99 },
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
      expect(descriptor.schema).toMatchObject({ type: "object", required: ["message", "count"], properties: { message: { type: "string", minLength: 1 }, count: { type: "string" } }, additionalProperties: false })
      expect(yield* editorSchema(SampleIntegrationConfiguration)).toMatchObject({ schema: { properties: { mailbox: { minLength: 1 } } } })
    }))
})
