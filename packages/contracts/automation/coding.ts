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

export const CodingAgentResult = Schema.Struct({
  agentKind: Schema.String.check(Schema.isMinLength(1)),
  sessionId: Schema.String.check(Schema.isMinLength(1)),
  transcript: Schema.Array(Schema.String),
  diffSummary: Schema.String,
  exitStatus: Schema.Int,
  durationMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  worktree: Schema.String.check(Schema.isMinLength(1)),
  repository: Schema.String.check(Schema.isMinLength(1))
})
export type CodingAgentResult = typeof CodingAgentResult.Type

export const codingIntegrationDefinition = defineIntegration({
  definition: { ...codingIntegrationReference },
  title: "Coding agent",
  capabilities: ["execute", "worktree", "transcript"],
  configurationSchema: CodingRepositoryConfiguration
})
