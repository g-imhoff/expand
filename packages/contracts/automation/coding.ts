import { Schema } from "effect"
import { defineIntegration } from "./extension.js"

export const codingIntegrationReference = { id: "coding-agent:integration", version: 1 } as const
export const codingActionReference = { id: "coding-agent:execute", version: 1 } as const

export const CodingRepositoryConfiguration = Schema.Struct({
  repository: Schema.String.check(Schema.isMinLength(1)),
  baseBranch: Schema.optional(Schema.String.check(Schema.isMinLength(1)))
})
export type CodingRepositoryConfiguration = typeof CodingRepositoryConfiguration.Type

export const CodingAgentArguments = Schema.Struct({
  prompt: Schema.String.check(Schema.isMinLength(1)),
  agentKind: Schema.String.check(Schema.isMinLength(1)),
  timeoutMs: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(300000))),
  requestedCapabilities: Schema.optional(Schema.Array(Schema.String.check(Schema.isMinLength(1))))
})
export type CodingAgentArguments = typeof CodingAgentArguments.Type

export const CapacityState = Schema.Literals(["available", "exhausted", "unknown", "unavailable"])
export type CapacityState = typeof CapacityState.Type

export const CapacityProbe = Schema.Struct({
  kind: Schema.String.check(Schema.isMinLength(1)),
  state: CapacityState,
  detail: Schema.String.check(Schema.isMinLength(1))
})
export type CapacityProbe = typeof CapacityProbe.Type

export const CodingProviderRule = Schema.Struct({
  kind: Schema.String.check(Schema.isMinLength(1)),
  priority: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  enabled: Schema.optional(Schema.Boolean)
})
export type CodingProviderRule = typeof CodingProviderRule.Type

export const CodingCapacitySelectionConfig = Schema.Struct({
  providers: Schema.Array(CodingProviderRule).check(Schema.isMinLength(1)),
  allowUnknownFallback: Schema.Boolean,
  fallbackKinds: Schema.optional(Schema.Array(Schema.String.check(Schema.isMinLength(1))))
})
export type CodingCapacitySelectionConfig = typeof CodingCapacitySelectionConfig.Type

export const CodingSelectionOutcome = Schema.Literals(["selected-available", "selected-unknown-fallback", "selected-fallback"])
export type CodingSelectionOutcome = typeof CodingSelectionOutcome.Type

export const CodingSelectionResult = Schema.Struct({
  selectedKind: Schema.String.check(Schema.isMinLength(1)),
  outcome: CodingSelectionOutcome,
  evidence: Schema.Array(CapacityProbe)
})
export type CodingSelectionResult = typeof CodingSelectionResult.Type

export const CodingAgentResult = Schema.Struct({
  agentKind: Schema.String.check(Schema.isMinLength(1)),
  sessionId: Schema.String.check(Schema.isMinLength(1)),
  transcript: Schema.Array(Schema.String),
  diffSummary: Schema.String,
  exitStatus: Schema.Int,
  durationMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  worktree: Schema.String.check(Schema.isMinLength(1)),
  repository: Schema.String.check(Schema.isMinLength(1)),
  selection: Schema.optional(CodingSelectionResult)
})
export type CodingAgentResult = typeof CodingAgentResult.Type

export const codingIntegrationDefinition = defineIntegration({
  definition: { ...codingIntegrationReference },
  title: "Coding agent",
  capabilities: ["execute", "worktree", "transcript"],
  configurationSchema: CodingRepositoryConfiguration
})
