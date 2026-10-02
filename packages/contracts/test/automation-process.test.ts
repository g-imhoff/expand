import { it } from "@effect/vitest"
import { Effect, Result, Schema } from "effect"
import { describe, expect, expectTypeOf, vi } from "vitest"
import { deriveSelectedActions, fieldBinding, resolveActionArguments, resolveBindings, validateProcess } from "@expand/contracts/automation/process"
import type { BindingSources, FieldPath } from "@expand/contracts/automation/process"

const processDefinition = {
  schemaVersion: 1, kind: "process",
  trigger: {
    definition: { id: "sample:trigger", version: 1 },
    integration: { id: "mail", definition: { id: "sample:integration", version: 1 } },
    configuration: {}
  }, actions: {}
}
const step = {
  id: "send", action: { id: "sample:send", version: 1 },
  integration: { id: "mail", definition: { id: "sample:integration", version: 1 } }, bindings: {}
}
const decision = { kind: "jev", provider: "opencode-zen", model: "jev", version: "1.13", outcomes: ["approved", "ignored"] }
const decisionProcess = { ...processDefinition, decision, actions: { approved: [{ ...step, id: "second" }, { ...step, id: "first" }], ignored: [] } }
const sources: BindingSources = { trigger: { sender: { name: "Owner" }, count: "5", labels: ["personal"] }, configuration: { prefix: "Hello" }, decision: { detail: { message: "Approved" } } }
const fail = Effect.fn("Test.fail")(function*<A, E>(effect: Effect.Effect<A, E>) {
  expect(Result.isFailure(yield* effect.pipe(Effect.result))).toBe(true)
})

describe("automation process", () => {
  it.effect("rejects outcome routes other than triggered when there is no decision", () =>
    fail(validateProcess({ ...processDefinition, actions: { approved: [] } })))

  it.effect("requires exactly one trigger and rejects graph, loop and expression keys", () =>
    Effect.gen(function*() {
      for (const input of [
        { ...processDefinition, trigger: [] }, { ...processDefinition, trigger: [processDefinition.trigger, processDefinition.trigger] },
        { schemaVersion: 1, kind: "process", actions: {} }, { ...processDefinition, triggers: [processDefinition.trigger] },
        { ...processDefinition, graph: {} }, { ...processDefinition, loops: [] }, { ...processDefinition, expression: "trigger.count + 1" },
        { ...processDefinition, decision: { ...decision, version: "1.14" } }, { ...processDefinition, decision: { ...decision, outcomes: [] } },
        { ...processDefinition, decision: { ...decision, outcomes: ["approved", "approved"] } },
        { ...decisionProcess, actions: { unknown: [] } },
        { ...decisionProcess, actions: { approved: [step, step] } }
      ]) yield* fail(validateProcess(input))
      expect(yield* validateProcess({ ...processDefinition, actions: { triggered: [step] } })).toMatchObject({ trigger: processDefinition.trigger })
    }))

  it.effect("derives ordered action lists and keeps unmatched or abstained decisions unresolved", () =>
    Effect.gen(function*() {
      expect(yield* deriveSelectedActions({ ...processDefinition, actions: { triggered: [step] } })).toEqual({ kind: "selected", outcomeId: "triggered", actions: [step] })
      const selected = yield* deriveSelectedActions(decisionProcess, { schemaVersion: 1, kind: "selected", outcomeId: "approved", data: {} })
      expect(selected.actions.map((step) => step.id)).toEqual(["second", "first"])
      expect(yield* deriveSelectedActions(decisionProcess, { schemaVersion: 1, kind: "abstained", reason: "unsure" })).toEqual({ kind: "unresolved", reason: "unsure", actions: [] })
      expect(yield* deriveSelectedActions(decisionProcess)).toMatchObject({ kind: "unresolved", actions: [] })
      yield* fail(deriveSelectedActions(decisionProcess, { schemaVersion: 1, kind: "selected", outcomeId: "absent", data: {} }))
      yield* fail(deriveSelectedActions(processDefinition, { schemaVersion: 1, kind: "selected", outcomeId: "approved", data: {} }))
      yield* fail(deriveSelectedActions(decisionProcess, { schemaVersion: 1, kind: "selected", outcomeId: "approved" }))
    }))

  it.effect("resolves literals and encoded own fields from the permitted sources", () =>
    Effect.gen(function*() {
      const resolved = yield* resolveBindings({
        literal: { kind: "literal", value: { enabled: true } },
        sender: { kind: "field", source: "trigger", path: ["sender", "name"] },
        count: { kind: "field", source: "trigger", path: ["count"] },
        label: { kind: "field", source: "trigger", path: ["labels", "0"] },
        prefix: { kind: "field", source: "configuration", path: ["prefix"] },
        message: { kind: "field", source: "decision", path: ["detail", "message"] }
      }, sources)
      expect(resolved).toEqual({ literal: { enabled: true }, sender: "Owner", count: "5", label: "personal", prefix: "Hello", message: "Approved" })
      const schema = Schema.Struct({ count: Schema.FiniteFromString })
      const args = yield* resolveActionArguments(schema, { count: fieldBinding(schema, "trigger", ["count"]) }, sources)
      expect(args).toEqual({ encoded: { count: "5" }, decoded: { count: 5 } })
      expectTypeOf(args.decoded).toEqualTypeOf<typeof schema.Type>()
      expectTypeOf<readonly ["count"]>().toExtend<FieldPath<typeof schema.Encoded>>()
      expectTypeOf<readonly ["count", "invalid"]>().not.toExtend<FieldPath<typeof schema.Encoded>>()
      yield* fail(resolveActionArguments(schema, { count: { kind: "literal", value: 5 } }, sources))
      yield* fail(resolveActionArguments(schema, {}, sources))
      yield* fail(resolveActionArguments(schema, { count: { kind: "literal", value: "5" }, extra: { kind: "literal", value: true } }, sources))
    }))

  it.effect("rejects unknown sources and paths, prototypes, accessors, action outputs and expressions", () =>
    Effect.gen(function*() {
      for (const binding of [
        { kind: "field", source: "action-output", path: ["send", "result"] },
        { kind: "field", source: "trigger", path: ["absent"] },
        { kind: "field", source: "trigger", path: [] },
        { kind: "field", source: "trigger", path: ["sender", "constructor"] },
        { kind: "field", source: "configuration", path: ["__proto__"] },
        { kind: "field", source: "decision", path: ["prototype"] },
        { kind: "expression", expression: "trigger.count + 1" },
        { kind: "literal", value: undefined }
      ]) yield* fail(resolveBindings({ value: binding }, sources))
      yield* fail(resolveBindings({ value: { kind: "field", source: "decision", path: ["detail"] } }, { trigger: {}, configuration: {} }))
      yield* fail(resolveBindings({ ["__proto__"]: { kind: "literal", value: "pollution" } }, sources))
      const inherited = Object.create({ value: "inherited" }) as Schema.Json
      yield* fail(resolveBindings({ value: { kind: "field", source: "trigger", path: ["value"] } }, { ...sources, trigger: inherited }))
      const getter = vi.fn(() => "read")
      const withAccessor = Object.defineProperty({}, "value", { get: getter, enumerable: true }) as Schema.Json
      yield* fail(resolveBindings({ value: { kind: "field", source: "trigger", path: ["value"] } }, { ...sources, trigger: withAccessor }))
      expect(getter).not.toHaveBeenCalled()
      yield* fail(validateProcess({ ...processDefinition, actions: { triggered: [{ ...step, bindings: { value: { kind: "field", source: "decision", path: ["detail"] } } }] } }))
    }))
})
