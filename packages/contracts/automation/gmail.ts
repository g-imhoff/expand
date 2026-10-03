import { Effect, Schema } from "effect"
import { AutomationError, decodeJson, IntegrationConfiguration, JsonValue } from "./descriptors.js"
import type { AutomationFailure, InvocationContext } from "./descriptors.js"
import { DefinitionReference, LocalId, sameDefinition } from "./ids.js"
import { fieldBinding, literalBinding, ProcessDefinition, validateProcess } from "./process.js"
import type { ActionStep } from "./process.js"
import { defineAction, defineExtension, defineIntegration, defineRoutine, defineTrigger } from "./extension.js"
import {
  EmailClassificationConfiguration,
  EmailLabelArguments,
  EmailLabelResult,
  EmailMailboxConfiguration,
  EmailMessagePayload,
  EmailTriggerConfiguration
} from "./email.js"

export const GmailMailboxConfiguration = EmailMailboxConfiguration
export const GmailTriggerConfiguration = EmailTriggerConfiguration
export const GmailMessagePayload = EmailMessagePayload
export const GmailLabelArguments = EmailLabelArguments
export const GmailLabelResult = EmailLabelResult
export const GmailNotifications = Schema.Struct({
  onMatch: Schema.Boolean,
  onNoMatch: Schema.Boolean
})
export const GmailClassificationConfiguration = EmailClassificationConfiguration
export const gmailIntegrationReference: DefinitionReference = { id: "gmail:integration", version: 1 }
export const gmailTriggerReference: DefinitionReference = { id: "gmail:message-received", version: 1 }
export const gmailLabelActionReference: DefinitionReference = { id: "gmail:label-message", version: 1 }
export const gmailTemplateReference: DefinitionReference = { id: "gmail:email-classification", version: 1 }
export const gmailIntegrationDefinition = defineIntegration({
  definition: gmailIntegrationReference, title: "Gmail", capabilities: ["label"],
  configurationSchema: GmailMailboxConfiguration
})
export const gmailTriggerDefinition = defineTrigger({
  definition: gmailTriggerReference, title: "Gmail message received", integration: gmailIntegrationReference,
  configurationSchema: GmailTriggerConfiguration, payloadSchema: GmailMessagePayload
})
export const buildGmailClassificationProcess = Effect.fn("Automation.buildGmailClassificationProcess")(function*(integrationId: unknown, classification: unknown) {
  const id = yield* decodeJson(LocalId, integrationId)
  const config = yield* decodeJson(GmailClassificationConfiguration, classification)
  const actions: Record<string, ReadonlyArray<ActionStep>> = {}
  for (const category of config.categories) {
    const label = config.labels[category]
    if (label === undefined) return yield* invalid("Missing label mapping")
    const move = config.moves?.[category]
    actions[category] = [{
      id: `label-${category}`,
      action: gmailLabelActionReference,
      integration: { id, definition: gmailIntegrationReference },
      bindings: {
        messageId: fieldBinding(GmailMessagePayload, "trigger", ["messageId"]),
        addLabelIds: literalBinding([label]),
        ...(move === undefined ? {} : { removeLabelIds: literalBinding([move]) })
      }
    }]
  }
  return yield* decodeJson(ProcessDefinition, {
    schemaVersion: 1, kind: "process",
    trigger: { definition: gmailTriggerReference, integration: { id, definition: gmailIntegrationReference }, configuration: {} },
    decision: { kind: "jev", provider: "opencode-zen", model: "jev", version: "1.13", outcomes: [...config.categories] },
    actions
  })
})
export const gmailClassificationTemplate = defineRoutine({
  definition: gmailTemplateReference, title: "Gmail email classification",
  configurationSchema: GmailClassificationConfiguration,
  process: Effect.runSync(buildGmailClassificationProcess("gmail", {
    categories: ["support", "receipts"],
    labels: { support: "Label_support", receipts: "Label_receipts" },
    notifications: { onMatch: true, onNoMatch: true }
  }))
})
export const validateGmailClassificationInput = Effect.fn("Automation.validateGmailClassificationInput")(function*(input: unknown) {
  const parsed = yield* decodeJson(ClassificationInput, input)
  const classification = yield* decodeJson(GmailClassificationConfiguration, parsed.configuration)
  const process = yield* validateProcess(parsed.process)
  const triggerConfiguration = yield* decodeJson(GmailTriggerConfiguration, process.trigger.configuration)
  if (Object.keys(triggerConfiguration).length > 0) return yield* invalid("Message trigger takes no configuration")
  if (!sameDefinition(process.trigger.definition, gmailTriggerReference)) return yield* invalid("Unknown classification trigger")
  const decision = process.decision
  if (decision === undefined || !sameSet(decision.outcomes, [...classification.categories])) return yield* invalid("Decision outcomes must match the configured categories")
  if (!sameSet(Object.keys(process.actions), [...classification.categories])) return yield* invalid("Action routes must match the configured categories")
  if (!sameSet(Object.keys(classification.labels), [...classification.categories])) return yield* invalid("Label mappings must cover every category exactly once")
  if (classification.moves !== undefined && !Object.keys(classification.moves).every((key) => classification.categories.includes(key))) {
    return yield* invalid("Move mappings must reference known categories")
  }
  for (const integration of parsed.integrations) {
    if (!sameDefinition(integration.definition, gmailIntegrationReference)) return yield* invalid("Unknown classification integration")
    yield* decodeJson(GmailMailboxConfiguration, integration.configuration)
  }
  const triggerInstance = parsed.integrations.find((candidate) => candidate.id === process.trigger.integration.id)
  if (triggerInstance === undefined || !sameDefinition(triggerInstance.definition, process.trigger.integration.definition)) return yield* invalid("Missing configured trigger integration")
  for (const category of classification.categories) {
    const steps = process.actions[category]
    if (steps === undefined || steps.length === 0) return yield* invalid("Every category needs at least one label action")
    const label = classification.labels[category]
    if (label === undefined) return yield* invalid("Missing label mapping")
    for (const step of steps) {
      if (!sameDefinition(step.action, gmailLabelActionReference)) return yield* invalid("Only the Gmail label action is allowed")
      const instance = parsed.integrations.find((candidate) => candidate.id === step.integration.id)
      if (instance === undefined || !sameDefinition(instance.definition, step.integration.definition)) return yield* invalid("Missing configured action integration")
      const messageBinding = step.bindings["messageId"]
      const addBinding = step.bindings["addLabelIds"]
      if (messageBinding === undefined || addBinding === undefined) return yield* invalid("Label actions need a message id and labels to add")
      if (addBinding.kind === "literal" && !includesLabel(addBinding.value, label)) return yield* invalid("Literal labels must use the mapped category label")
      const move = classification.moves?.[category]
      if (move !== undefined) {
        const removeBinding = step.bindings["removeLabelIds"]
        if (removeBinding !== undefined && removeBinding.kind === "literal" && !includesLabel(removeBinding.value, move)) {
          return yield* invalid("Literal removals must use the mapped move label")
        }
      }
    }
  }
  return { classification, process }
})
export type GmailLabelHandler<Requirements = never> = (args: typeof GmailLabelArguments.Type, configuration: typeof GmailMailboxConfiguration.Type, context: InvocationContext) => Effect.Effect<typeof GmailLabelResult.Type, AutomationFailure, Requirements>
export const makeGmailExtension = <Requirements = never>(handler: GmailLabelHandler<Requirements> = () => Effect.succeed({ applied: true })) => {
  const action = defineAction({
    definition: gmailLabelActionReference, title: "Gmail label message", integration: gmailIntegrationReference,
    capabilities: ["label"], argumentsSchema: GmailLabelArguments, resultSchema: GmailLabelResult,
    integrationConfigurationSchema: GmailMailboxConfiguration, handler
  })
  return { action, extension: defineExtension({ integrations: [gmailIntegrationDefinition], triggers: [gmailTriggerDefinition], actions: [action], routines: [gmailClassificationTemplate] }) }
}

const ClassificationInput = Schema.Struct({
  configuration: JsonValue,
  integrations: Schema.Array(IntegrationConfiguration),
  process: ProcessDefinition
})
function sameSet(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((value) => right.includes(value))
}
function includesLabel(value: unknown, label: string): boolean {
  return Array.isArray(value) && value.includes(label)
}
function invalid(message: string): AutomationError {
  return new AutomationError({ code: "invalid-reference", message })
}
