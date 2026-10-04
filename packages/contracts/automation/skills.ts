import { Schema } from "effect"

export const skillActionReference = { id: "coding-skill:execute", version: 1 } as const

export const SkillCheckResult = Schema.Struct({
  check: Schema.String.check(Schema.isMinLength(1)),
  passed: Schema.Boolean,
  detail: Schema.optional(Schema.String)
})
export type SkillCheckResult = typeof SkillCheckResult.Type

export const SkillExecuteArguments = Schema.Struct({
  skillId: Schema.String.check(Schema.isMinLength(1)),
  inputs: Schema.Json,
  timeoutMs: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(300000))),
  agentKind: Schema.optional(Schema.String.check(Schema.isMinLength(1)))
})
export type SkillExecuteArguments = typeof SkillExecuteArguments.Type

export const SkillExecuteResult = Schema.Struct({
  skillId: Schema.String.check(Schema.isMinLength(1)),
  agentKind: Schema.String.check(Schema.isMinLength(1)),
  sessionId: Schema.String.check(Schema.isMinLength(1)),
  transcript: Schema.Array(Schema.String),
  diffSummary: Schema.String,
  exitStatus: Schema.Int,
  durationMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  worktree: Schema.String.check(Schema.isMinLength(1)),
  repository: Schema.String.check(Schema.isMinLength(1)),
  checks: Schema.Array(SkillCheckResult)
})
export type SkillExecuteResult = typeof SkillExecuteResult.Type

export const SampleWriteFileInput = Schema.Struct({
  content: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500))
})
export type SampleWriteFileInput = typeof SampleWriteFileInput.Type
