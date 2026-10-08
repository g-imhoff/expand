import { Schema } from "effect"
import { defineIntegration, defineTrigger } from "./extension.js"

export const pipelineIntegrationReference = { id: "pipeline:integration", version: 1 } as const
export const pipelineTriggerReference = { id: "github:workflow-failed", version: 1 } as const
export const pipelineRepairActionReference = { id: "pipeline:repair", version: 1 } as const
export const pipelineTemplateReference = { id: "pipeline:failed-repair", version: 1 } as const

export const PipelineWorkflowPayload = Schema.Struct({
  runId: Schema.Int.check(Schema.isGreaterThan(0)),
  owner: Schema.String.check(Schema.isMinLength(1)),
  repo: Schema.String.check(Schema.isMinLength(1)),
  branch: Schema.String.check(Schema.isMinLength(1)),
  sha: Schema.String.check(Schema.isMinLength(1)),
  workflow: Schema.String.check(Schema.isMinLength(1)),
  conclusion: Schema.Literal("failure")
})
export type PipelineWorkflowPayload = typeof PipelineWorkflowPayload.Type

export const PipelineRepairConfiguration = Schema.Struct({
  repairSkillId: Schema.String.check(Schema.isMinLength(1)),
  githubIntegrationId: Schema.String.check(Schema.isMinLength(1)),
  codingIntegrationId: Schema.String.check(Schema.isMinLength(1)),
  maxAttempts: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(5)),
  protectedBranches: Schema.Array(Schema.String.check(Schema.isMinLength(1))),
  allowedBranches: Schema.optional(Schema.Array(Schema.String.check(Schema.isMinLength(1)))),
  requireDraft: Schema.Boolean
})
export type PipelineRepairConfiguration = typeof PipelineRepairConfiguration.Type

export const PipelineRepairArguments = Schema.Struct({
  runId: Schema.Int.check(Schema.isGreaterThan(0)),
  owner: Schema.String.check(Schema.isMinLength(1)),
  repo: Schema.String.check(Schema.isMinLength(1)),
  branch: Schema.String.check(Schema.isMinLength(1)),
  sha: Schema.String.check(Schema.isMinLength(1)),
  workflow: Schema.String.check(Schema.isMinLength(1)),
  logsSnippet: Schema.optional(Schema.String.check(Schema.isMinLength(1)))
})
export type PipelineRepairArguments = typeof PipelineRepairArguments.Type

export const PipelineRepairCheck = Schema.Struct({
  check: Schema.String.check(Schema.isMinLength(1)),
  passed: Schema.Boolean,
  detail: Schema.optional(Schema.String)
})
export type PipelineRepairCheck = typeof PipelineRepairCheck.Type

export const PipelineRepairResult = Schema.Struct({
  runId: Schema.Int.check(Schema.isGreaterThan(0)),
  branch: Schema.String.check(Schema.isMinLength(1)),
  repaired: Schema.Boolean,
  attempts: Schema.Int.check(Schema.isGreaterThan(0)),
  skillId: Schema.String.check(Schema.isMinLength(1)),
  checks: Schema.Array(PipelineRepairCheck),
  draftPr: Schema.optional(Schema.Struct({
    base: Schema.String.check(Schema.isMinLength(1)),
    head: Schema.String.check(Schema.isMinLength(1)),
    draft: Schema.Boolean
  }))
})
export type PipelineRepairResult = typeof PipelineRepairResult.Type

export const PipelineWebhookWorkflowRun = Schema.Struct({
  id: Schema.Int.check(Schema.isGreaterThan(0)),
  head_branch: Schema.String.check(Schema.isMinLength(1)),
  head_sha: Schema.String.check(Schema.isMinLength(1)),
  conclusion: Schema.String,
  name: Schema.optional(Schema.String),
  html_url: Schema.optional(Schema.String)
})
export type PipelineWebhookWorkflowRun = typeof PipelineWebhookWorkflowRun.Type

export const PipelineWebhookEvent = Schema.Struct({
  action: Schema.Literal("completed"),
  workflow_run: PipelineWebhookWorkflowRun,
  repository: Schema.Struct({
    name: Schema.String.check(Schema.isMinLength(1)),
    owner: Schema.Struct({ login: Schema.String.check(Schema.isMinLength(1)) })
  })
})
export type PipelineWebhookEvent = typeof PipelineWebhookEvent.Type

export const pipelineIntegrationDefinition = defineIntegration({
  definition: { ...pipelineIntegrationReference },
  title: "Pipeline repair",
  capabilities: ["repair"],
  configurationSchema: PipelineRepairConfiguration
})

export const pipelineFailureTriggerDefinition = defineTrigger({
  definition: { ...pipelineTriggerReference },
  title: "GitHub workflow failed",
  integration: { ...pipelineIntegrationReference },
  configurationSchema: Schema.Struct({}),
  payloadSchema: PipelineWorkflowPayload
})
