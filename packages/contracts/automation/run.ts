import { Schema } from "effect"
import { AutomationFailure, JsonValue } from "./descriptors.js"
import { ConfigurationReference, DefinitionReference, LocalId, PersonalScope } from "./ids.js"

export const OriginalInputReference = Schema.Struct({ kind: Schema.Literal("input-reference"), id: LocalId })
export type OriginalInputReference = typeof OriginalInputReference.Type
export const JevDecisionRequest = Schema.Struct({
  schemaVersion: Schema.Literal(1), kind: Schema.Literal("jev-request"),
  provider: Schema.Literal("opencode-zen"), model: Schema.Literal("jev"), version: Schema.Literal("1.13"),
  configuration: ConfigurationReference, input: OriginalInputReference,
  outcomes: Schema.Array(LocalId).check(Schema.isMinLength(1), Schema.isUnique()), data: JsonValue
})
export type JevDecisionRequest = typeof JevDecisionRequest.Type
export const JevDecisionResult = Schema.Union([
  Schema.Struct({ schemaVersion: Schema.Literal(1), kind: Schema.Literal("selected"), outcomeId: LocalId, data: JsonValue }),
  Schema.Struct({ schemaVersion: Schema.Literal(1), kind: Schema.Literal("abstained"), reason: Schema.String })
])
export type JevDecisionResult = typeof JevDecisionResult.Type
export const ActionOutcome = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("planned"), stepId: LocalId, action: DefinitionReference, arguments: JsonValue }),
  Schema.Struct({ kind: Schema.Literal("succeeded"), stepId: LocalId, action: DefinitionReference, result: JsonValue }),
  Schema.Struct({ kind: Schema.Literal("failed"), stepId: LocalId, action: DefinitionReference, error: AutomationFailure }),
  Schema.Struct({ kind: Schema.Literal("skipped"), stepId: LocalId, action: DefinitionReference, reason: Schema.String })
])
export type ActionOutcome = typeof ActionOutcome.Type
export const ActionGrant = Schema.Struct({ action: DefinitionReference, integrationId: LocalId, capabilities: Schema.Array(LocalId).check(Schema.isUnique()) })
export type ActionGrant = typeof ActionGrant.Type
export const InvocationAuthority = Schema.Struct({
  schemaVersion: Schema.Literal(1), kind: Schema.Literal("invocation-authority"), scope: PersonalScope,
  configuration: ConfigurationReference, integrationIds: Schema.Array(LocalId).check(Schema.isUnique()),
  actionGrants: Schema.Array(ActionGrant)
})
export type InvocationAuthority = typeof InvocationAuthority.Type
export const RunState = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("queued") }),
  Schema.Struct({ kind: Schema.Literal("running") }),
  Schema.Struct({ kind: Schema.Literal("succeeded"), result: JsonValue }),
  Schema.Struct({ kind: Schema.Literal("unresolved"), reason: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("failed"), error: AutomationFailure }),
  Schema.Struct({ kind: Schema.Literal("cancelled"), reason: Schema.String })
])
export type RunState = typeof RunState.Type
export const AutomationRun = Schema.Struct({
  schemaVersion: Schema.Literal(1), kind: Schema.Literal("run"), id: LocalId, scope: PersonalScope,
  configuration: ConfigurationReference, input: OriginalInputReference,
  mode: Schema.Literals(["preview", "live"]), authority: InvocationAuthority,
  state: RunState, actions: Schema.Array(ActionOutcome), decision: Schema.optional(JevDecisionResult)
})
export type AutomationRun = typeof AutomationRun.Type
