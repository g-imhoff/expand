import { it } from "@effect/vitest"
import { Effect, Result, Schema } from "effect"
import { describe, expect, expectTypeOf } from "vitest"
import {
  ActionDescriptor, ActionOutcome, AutomationRun, Catalog, CredentialReference, decodeJson, DefinitionReference,
  editorSchema, IntegrationConfiguration, IntegrationDescriptor, InvocationAuthority, JevDecisionRequest, JevDecisionResult,
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
        count: Schema.FiniteFromString, note: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
        choice: Schema.Union([Schema.Literal("skip"), Schema.Struct({ enabled: Schema.Boolean })])
      })
      const descriptor = yield* editorSchema(schema)
      expect(descriptor.schema).toMatchObject({ type: "object", required: ["count", "choice"], additionalProperties: false, properties: { count: { type: "string" } } })
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
