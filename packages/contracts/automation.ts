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
  EmailClassificationConfiguration, EmailLabelArguments, EmailLabelResult, EmailMailboxConfiguration,
  EmailMessagePayload, EmailNotifications, EmailTriggerConfiguration
} from "./automation/email.js"
export {
  GmailClassificationConfiguration, GmailLabelArguments, GmailLabelResult, GmailMailboxConfiguration,
  GmailMessagePayload, GmailNotifications, GmailTriggerConfiguration, buildGmailClassificationProcess,
  gmailClassificationTemplate, gmailIntegrationDefinition, gmailIntegrationReference, gmailLabelActionReference,
  gmailTemplateReference, gmailTriggerDefinition, gmailTriggerReference, makeGmailExtension,
  validateGmailClassificationInput
} from "./automation/gmail.js"
export type { GmailLabelHandler } from "./automation/gmail.js"
export { OriginalInputReference, JevDecisionRequest, JevDecisionResult, ActionOutcome, ActionGrant, InvocationAuthority, RunState, AutomationRun } from "./automation/run.js"
export { Delivery, Job, Attempt, RoutineStatus, CredentialStatus } from "./automation/execution.js"
export { AutomationNotification, AutomationNotificationKind, AutomationNotificationStatus } from "./automation/notifications.js"
export { defineIntegration, defineTrigger, defineRoutine, defineAction, defineExtension } from "./automation/extension.js"
export type { IntegrationDefinition, TriggerDefinition, ActionDefinition, RoutineDefinition, AutomationExtension, ContextFreeCodec, InstalledAction } from "./automation/extension.js"
