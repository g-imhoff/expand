export { DefinitionId, PositiveVersion, LocalId, DefinitionReference, PersonalScope, ConfigurationReference, IntegrationReference, CredentialReference, definitionKey, sameDefinition } from "./automation/ids.js"
export { AutomationError, JsonValue, EditorSchema, IntegrationConfiguration, IntegrationDescriptor, TriggerDescriptor, ActionDescriptor, RoutineDescriptor, DefinitionDescriptor, Catalog, AutomationFailure, InvocationContext, isJsonValue, decodeJson, editorSchema } from "./automation/descriptors.js"
export { Binding, fieldBinding, literalBinding, ActionStep, JevDecision, ProcessDefinition, RoutineConfiguration, validateProcess, deriveSelectedActions, resolveBindings, resolveActionArguments } from "./automation/process.js"
export type { BindingSources, FieldPath, ActionSelection } from "./automation/process.js"
export {
  GithubClassificationConfiguration, GithubIssuePayload, GithubIssueTriggerConfiguration, GithubLabelArguments,
  GithubLabelResult, GithubNotifications, GithubRepositoryConfiguration, buildGithubClassificationProcess,
  githubClassificationTemplate, githubIntegrationDefinition, githubIntegrationReference, githubLabelActionReference,
  githubTemplateReference, githubTriggerDefinition, githubTriggerReference, makeGithubExtension,
  validateClassificationInput
} from "./automation/github.js"
export type { GithubLabelHandler } from "./automation/github.js"
export { OriginalInputReference, JevDecisionRequest, JevDecisionResult, ActionOutcome, ActionGrant, InvocationAuthority, RunState, AutomationRun } from "./automation/run.js"
export {
  CodingAgentKind, CodingAgentAction, CodingRepositoryConfiguration, CodingRunArguments, CodingRunResult,
  CodingManualPayload, codingIntegrationReference, codingTriggerReference, codingActionReference,
  codingIntegrationDefinition, codingTriggerDefinition, resolveCodingAgent, resolveCodingDeadlineMs,
  isPermittedCodingRepository, makeCodingExtension, decodeCodingArguments, decodeCodingConfiguration,
  decodeCodingIntegration, codingReferences, isCodingReference, codingFailure, invalidCodingReference
} from "./automation/coding.js"
export type { CodingActionHandler } from "./automation/coding.js"
export { Delivery, Job, Attempt, RoutineStatus, CredentialStatus } from "./automation/execution.js"
export { AutomationNotification, AutomationNotificationKind, AutomationNotificationStatus } from "./automation/notifications.js"
export { defineIntegration, defineTrigger, defineRoutine, defineAction, defineExtension } from "./automation/extension.js"
export type { IntegrationDefinition, TriggerDefinition, ActionDefinition, RoutineDefinition, AutomationExtension, ContextFreeCodec, InstalledAction } from "./automation/extension.js"
