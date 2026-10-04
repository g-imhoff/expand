import { Effect, Schema } from "effect"
import { AutomationError, decodeJson, IntegrationConfiguration, JsonValue } from "./descriptors.js"
import type { AutomationFailure, InvocationContext } from "./descriptors.js"
import { DefinitionReference, LocalId, sameDefinition } from "./ids.js"
import { fieldBinding, literalBinding, ProcessDefinition, validateProcess } from "./process.js"
import type { ActionStep } from "./process.js"
import { defineAction, defineExtension, defineIntegration, defineRoutine, defineTrigger } from "./extension.js"
export const GmailMailboxConfiguration = Schema.Struct({
  mailbox: Schema.String.check(Schema.isMinLength(1))
})
export const EmailTriggerConfiguration = Schema.Struct({})
export const EmailMessagePayload = Schema.Struct({
  messageId: Schema.String.check(Schema.isMinLength(1)),
  threadId: Schema.String.check(Schema.isMinLength(1))
})
export const GmailOrganizeArguments = Schema.Struct({
  messageId: Schema.String.check(Schema.isMinLength(1)),
  label: Schema.String.check(Schema.isMinLength(1)),
  moveTo: Schema.String.check(Schema.isMinLength(1))
})
export const GmailOrganizeResult = Schema.Struct({ applied: Schema.Boolean, moved: Schema.Boolean })
export const GmailNotifications = Schema.Struct({
  onMatch: Schema.Boolean,
  onNoMatch: Schema.Boolean
})
export const GmailClassificationConfiguration = Schema.Struct({
  categories: Schema.Array(LocalId).check(Schema.isMinLength(1), Schema.isUnique()),
  labels: Schema.Record(Schema.String, Schema.String.check(Schema.isMinLength(1))),
  moves: Schema.Record(Schema.String, Schema.String.check(Schema.isMinLength(1))),
  notifications: GmailNotifications
})
export const gmailIntegrationReference: DefinitionReference = { id: "gmail:integration", version: 1 }
export const emailTriggerReference: DefinitionReference = { id: "email:message-received", version: 1 }
export const emailOrganizeActionReference: DefinitionReference = { id: "email:organize-message", version: 1 }
export const gmailTemplateReference: DefinitionReference = { id: "gmail:email-classification", version: 1 }
export const gmailIntegrationDefinition = defineIntegration({
  definition: gmailIntegrationReference, title: "Gmail", capabilities: ["label", "move"],
  configurationSchema: GmailMailboxConfiguration
})
export const emailTriggerDefinition = defineTrigger({
  definition: emailTriggerReference, title: "Email message received", integration: gmailIntegrationReference,
  configurationSchema: EmailTriggerConfiguration, payloadSchema: EmailMessagePayload
})
export const buildGmailClassificationProcess = Effect.fn("Automation.buildGmailClassificationProcess")(function*(integrationId: unknown, classification: unknown) {
  const id = yield* decodeJson(LocalId, integrationId)
  const config = yield* decodeJson(GmailClassificationConfiguration, classification)
  const actions: Record<string, ReadonlyArray<ActionStep>> = {}
  for (const category of config.categories) {
    const label = config.labels[category]
    const moveTo = config.moves[category]
    if (label === undefined) return yield* invalid("Missing label mapping")
    if (moveTo === undefined) return yield* invalid("Missing folder mapping")
    actions[category] = [{
      id: `organize-${category}`,
      action: emailOrganizeActionReference,
      integration: { id, definition: gmailIntegrationReference },
      bindings: {
        messageId: fieldBinding(EmailMessagePayload, "trigger", ["messageId"]),
        label: literalBinding(label),
        moveTo: literalBinding(moveTo)
      }
    }]
  }
  return yield* decodeJson(ProcessDefinition, {
    schemaVersion: 1, kind: "process",
    trigger: { definition: emailTriggerReference, integration: { id, definition: gmailIntegrationReference }, configuration: {} },
    decision: { kind: "jev", provider: "opencode-zen", model: "jev", version: "1.13", outcomes: [...config.categories] },
    actions
  })
})
export const gmailClassificationTemplate = defineRoutine({
  definition: gmailTemplateReference, title: "Gmail email classification",
  configurationSchema: GmailClassificationConfiguration,
  process: Effect.runSync(buildGmailClassificationProcess("gmail", {
    categories: ["receipts", "action"],
    labels: { receipts: "Label_receipts", action: "Label_action" },
    moves: { receipts: "Label_receipts", action: "INBOX" },
    notifications: { onMatch: true, onNoMatch: true }
  }))
})
export const validateGmailClassificationInput = Effect.fn("Automation.validateGmailClassificationInput")(function*(input: unknown) {
  const parsed = yield* decodeJson(ClassificationInput, input)
  const classification = yield* decodeJson(GmailClassificationConfiguration, parsed.configuration)
  const process = yield* validateProcess(parsed.process)
  const triggerConfiguration = yield* decodeJson(EmailTriggerConfiguration, process.trigger.configuration)
  if (Object.keys(triggerConfiguration).length > 0) return yield* invalid("Email trigger takes no configuration")
  if (!sameDefinition(process.trigger.definition, emailTriggerReference)) return yield* invalid("Unknown classification trigger")
  const decision = process.decision
  if (decision === undefined || !sameSet(decision.outcomes, [...classification.categories])) return yield* invalid("Decision outcomes must match the configured categories")
  if (!sameSet(Object.keys(process.actions), [...classification.categories])) return yield* invalid("Action routes must match the configured categories")
  if (!sameSet(Object.keys(classification.labels), [...classification.categories])) return yield* invalid("Label mappings must cover every category exactly once")
  if (!sameSet(Object.keys(classification.moves), [...classification.categories])) return yield* invalid("Folder mappings must cover every category exactly once")
  for (const integration of parsed.integrations) {
    if (!sameDefinition(integration.definition, gmailIntegrationReference)) return yield* invalid("Unknown classification integration")
    yield* decodeJson(GmailMailboxConfiguration, integration.configuration)
  }
  const triggerInstance = parsed.integrations.find((candidate) => candidate.id === process.trigger.integration.id)
  if (triggerInstance === undefined || !sameDefinition(triggerInstance.definition, process.trigger.integration.definition)) return yield* invalid("Missing configured trigger integration")
  for (const category of classification.categories) {
    const steps = process.actions[category]
    if (steps === undefined || steps.length !== 1) return yield* invalid("Every category needs exactly one organize action")
    const label = classification.labels[category]
    const moveTo = classification.moves[category]
    if (label === undefined) return yield* invalid("Missing label mapping")
    if (moveTo === undefined) return yield* invalid("Missing folder mapping")
    const step = steps[0]!
    if (!sameDefinition(step.action, emailOrganizeActionReference)) return yield* invalid("Only the email organize action is allowed")
    const instance = parsed.integrations.find((candidate) => candidate.id === step.integration.id)
    if (instance === undefined || !sameDefinition(instance.definition, step.integration.definition)) return yield* invalid("Missing configured action integration")
    const keys = Object.keys(step.bindings).sort()
    if (keys.length !== 3 || keys[0] !== "label" || keys[1] !== "messageId" || keys[2] !== "moveTo") return yield* invalid("Organize actions need a message id with label and destination")
    const messageBinding = step.bindings["messageId"]!
    const labelBinding = step.bindings["label"]!
    const moveBinding = step.bindings["moveTo"]!
    if (messageBinding.kind !== "field" || messageBinding.source !== "trigger" || messageBinding.path.length !== 1 || messageBinding.path[0] !== "messageId") return yield* invalid("Organize actions need the trigger message id")
    if (labelBinding.kind !== "literal" || labelBinding.value !== label) return yield* invalid("Literal labels must use the mapped category label")
    if (moveBinding.kind !== "literal" || moveBinding.value !== moveTo) return yield* invalid("Literal destinations must use the mapped category folder")
  }
  return { classification, process }
})
export type GmailOrganizeHandler = (args: typeof GmailOrganizeArguments.Type, configuration: typeof GmailMailboxConfiguration.Type, context: InvocationContext) => Effect.Effect<typeof GmailOrganizeResult.Type, AutomationFailure>
export const makeGmailExtension = (handler: GmailOrganizeHandler = () => Effect.succeed({ applied: true, moved: false })) => {
  const action = defineAction({
    definition: emailOrganizeActionReference, title: "Email organize message", integration: gmailIntegrationReference,
    capabilities: ["label", "move"], argumentsSchema: GmailOrganizeArguments, resultSchema: GmailOrganizeResult,
    integrationConfigurationSchema: GmailMailboxConfiguration, handler
  })
  return { action, extension: defineExtension({ integrations: [gmailIntegrationDefinition], triggers: [emailTriggerDefinition], actions: [action], routines: [gmailClassificationTemplate] }) }
}
const ClassificationInput = Schema.Struct({
  configuration: JsonValue,
  integrations: Schema.Array(IntegrationConfiguration),
  process: ProcessDefinition
})
function sameSet(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((value) => right.includes(value))
}
function invalid(message: string): AutomationError {
  return new AutomationError({ code: "invalid-reference", message })
}
