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
export {
  GmailClassificationConfiguration, EmailMessagePayload, EmailTriggerConfiguration, GmailMailboxConfiguration,
  GmailOrganizeArguments, GmailOrganizeResult, GmailNotifications, buildGmailClassificationProcess,
  emailOrganizeActionReference, emailTriggerDefinition, emailTriggerReference, gmailClassificationTemplate,
  gmailIntegrationDefinition, gmailIntegrationReference, gmailTemplateReference, makeGmailExtension,
  validateGmailClassificationInput
} from "./automation/gmail.js"
export type { GmailOrganizeHandler } from "./automation/gmail.js"
export { OriginalInputReference, JevDecisionRequest, JevDecisionResult, ActionOutcome, ActionGrant, InvocationAuthority, RunState, AutomationRun } from "./automation/run.js"
export { defineIntegration, defineTrigger, defineRoutine, defineAction, defineExtension } from "./automation/extension.js"
export type { IntegrationDefinition, TriggerDefinition, ActionDefinition, RoutineDefinition, AutomationExtension, ContextFreeCodec, InstalledAction } from "./automation/extension.js"
export { CustomWebhookBody, CustomWebhookCredentialSlot, defineCustomTrigger } from "./automation/custom.js"
export type { CustomTriggerDefinition } from "./automation/custom.js"
export { AutomationNotification, AutomationNotificationKind, AutomationNotificationStatus } from "./automation/notifications.js"
export { codingIntegrationReference, codingActionReference, CodingRepositoryConfiguration, CodingAgentArguments, CodingAgentResult, codingIntegrationDefinition, CapacityState, CapacityProbe, CodingProviderRule, CodingCapacitySelectionConfig, CodingSelectionOutcome, CodingSelectionResult } from "./automation/coding.js"
export { skillActionReference, SkillCheckResult, SkillExecuteArguments, SkillExecuteResult, SampleWriteFileInput } from "./automation/skills.js"
