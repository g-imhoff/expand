import { Effect, Schema } from "effect"
import { AutomationError, decodeJson, IntegrationConfiguration, JsonValue } from "./descriptors.js"
import type { AutomationFailure, InvocationContext } from "./descriptors.js"
import { CredentialReference, DefinitionReference, LocalId, sameDefinition } from "./ids.js"
import { defineAction, defineExtension, defineIntegration, defineTrigger } from "./extension.js"

export interface CodingActionHandler<Requirements = never> {
  (
    args: typeof CodingRunArguments.Type,
    configuration: typeof CodingRepositoryConfiguration.Type,
    context: InvocationContext
  ): Effect.Effect<typeof CodingRunResult.Type, AutomationFailure, Requirements>
}

export const CodingAgentKind = Schema.Union([Schema.Literal("opencode"), Schema.Literal("stub")])
export type CodingAgentKind = typeof CodingAgentKind.Type
export const CodingAgentAction = Schema.Union([Schema.Literal("read"), Schema.Literal("edit"), Schema.Literal("bash")])
export type CodingAgentAction = typeof CodingAgentAction.Type
export const CodingRepositoryConfiguration = Schema.Struct({
  allowedRepositories: Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(Schema.isMinLength(1), Schema.isUnique()),
  worktreeRoot: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  agent: Schema.optional(CodingAgentKind),
  defaultDeadlineMs: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(3600000)))
})
export type CodingRepositoryConfiguration = typeof CodingRepositoryConfiguration.Type
export const CodingRunArguments = Schema.Struct({
  repository: Schema.String.check(Schema.isMinLength(1)),
  task: Schema.String.check(Schema.isMinLength(1)),
  branch: Schema.optional(LocalId),
  allowedActions: Schema.Array(CodingAgentAction).check(Schema.isMinLength(1), Schema.isUnique()),
  credentials: Schema.optional(Schema.Record(Schema.String, CredentialReference)),
  deadlineMs: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(3600000)))
})
export type CodingRunArguments = typeof CodingRunArguments.Type
export const CodingRunResult = Schema.Struct({
  sessionId: Schema.String.check(Schema.isMinLength(1)),
  agent: CodingAgentKind,
  exitStatus: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  durationMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  transcript: Schema.Array(Schema.String),
  diffSummary: Schema.String,
  filesChanged: Schema.Array(Schema.String)
})
export type CodingRunResult = typeof CodingRunResult.Type
export const CodingManualPayload = Schema.Struct({ task: Schema.String.check(Schema.isMinLength(1)) })
export type CodingManualPayload = typeof CodingManualPayload.Type
export const codingIntegrationReference: DefinitionReference = { id: "coding:repository", version: 1 }
export const codingTriggerReference: DefinitionReference = { id: "coding:manual", version: 1 }
export const codingActionReference: DefinitionReference = { id: "coding:run-agent", version: 1 }
export const codingIntegrationDefinition = defineIntegration({
  definition: codingIntegrationReference, title: "Coding repository", capabilities: ["code"],
  configurationSchema: CodingRepositoryConfiguration
})
export const codingTriggerDefinition = defineTrigger({
  definition: codingTriggerReference, title: "Manual coding request", integration: codingIntegrationReference,
  configurationSchema: Schema.Struct({}), payloadSchema: CodingManualPayload
})
export const resolveCodingAgent = (configuration: typeof CodingRepositoryConfiguration.Type): CodingAgentKind =>
  configuration.agent ?? "opencode"
export const resolveCodingDeadlineMs = (
  args: typeof CodingRunArguments.Type,
  configuration: typeof CodingRepositoryConfiguration.Type
): number => args.deadlineMs ?? configuration.defaultDeadlineMs ?? 300000
export const isPermittedCodingRepository = (
  configuration: typeof CodingRepositoryConfiguration.Type,
  repository: string
): boolean => configuration.allowedRepositories.includes(repository)
export const makeCodingExtension = <Requirements = never>(handler: CodingActionHandler<Requirements>) => {
  const action = defineAction({
    definition: codingActionReference, title: "Run coding agent", integration: codingIntegrationReference,
    capabilities: ["code"], argumentsSchema: CodingRunArguments, resultSchema: CodingRunResult,
    integrationConfigurationSchema: CodingRepositoryConfiguration, handler
  })
  return { action, extension: defineExtension({ integrations: [codingIntegrationDefinition], triggers: [codingTriggerDefinition], actions: [action], routines: [] }) }
}
export const decodeCodingArguments = (input: unknown) => decodeJson(CodingRunArguments, input)
export const decodeCodingConfiguration = (input: unknown) => decodeJson(CodingRepositoryConfiguration, input)
export const decodeCodingIntegration = (input: unknown) => decodeJson(IntegrationConfiguration, input)
export const codingReferences: ReadonlyArray<DefinitionReference> = [codingIntegrationReference, codingTriggerReference, codingActionReference]
export const isCodingReference = (reference: DefinitionReference): boolean =>
  codingReferences.some((candidate) => sameDefinition(candidate, reference))
export const codingFailure = (code: string, message: string, details?: JsonValue): AutomationFailure => ({
  code, message, ...(details === undefined ? {} : { details })
})
export const invalidCodingReference = (message: string): AutomationError =>
  new AutomationError({ code: "invalid-reference", message })
