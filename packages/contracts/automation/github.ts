import { Effect, Schema } from "effect"
import { AutomationError, decodeJson, IntegrationConfiguration, JsonValue } from "./descriptors.js"
import type { AutomationFailure, InvocationContext } from "./descriptors.js"
import { DefinitionReference, LocalId, sameDefinition } from "./ids.js"
import { fieldBinding, literalBinding, ProcessDefinition, validateProcess } from "./process.js"
import type { ActionStep } from "./process.js"
import { defineAction, defineExtension, defineIntegration, defineRoutine, defineTrigger } from "./extension.js"

export const GithubRepositoryConfiguration = Schema.Struct({
  owner: Schema.String.check(Schema.isMinLength(1)),
  repo: Schema.String.check(Schema.isMinLength(1))
})
export const GithubIssueTriggerConfiguration = Schema.Struct({})
export const GithubIssuePayload = Schema.Struct({
  issueNumber: Schema.Int.check(Schema.isGreaterThan(0)),
  title: Schema.String.check(Schema.isMinLength(1)),
  body: Schema.optional(Schema.String)
})
export const GithubLabelArguments = Schema.Struct({
  issueNumber: Schema.Int.check(Schema.isGreaterThan(0)),
  label: Schema.String.check(Schema.isMinLength(1))
})
export const GithubLabelResult = Schema.Struct({ applied: Schema.Boolean })
export const GithubNotifications = Schema.Struct({
  onMatch: Schema.Boolean,
  onNoMatch: Schema.Boolean
})
export const GithubClassificationConfiguration = Schema.Struct({
  categories: Schema.Array(LocalId).check(Schema.isMinLength(1), Schema.isUnique()),
  labels: Schema.Record(Schema.String, Schema.String.check(Schema.isMinLength(1))),
  notifications: GithubNotifications
})
export const githubIntegrationReference: DefinitionReference = { id: "github:integration", version: 1 }
export const githubTriggerReference: DefinitionReference = { id: "github:issue-opened", version: 1 }
export const githubLabelActionReference: DefinitionReference = { id: "github:label-issue", version: 1 }
export const githubTemplateReference: DefinitionReference = { id: "github:issue-classification", version: 1 }
export const githubIntegrationDefinition = defineIntegration({
  definition: githubIntegrationReference, title: "GitHub", capabilities: ["label"],
  configurationSchema: GithubRepositoryConfiguration
})
export const githubTriggerDefinition = defineTrigger({
  definition: githubTriggerReference, title: "GitHub issue opened", integration: githubIntegrationReference,
  configurationSchema: GithubIssueTriggerConfiguration, payloadSchema: GithubIssuePayload
})
export const buildGithubClassificationProcess = Effect.fn("Automation.buildGithubClassificationProcess")(function*(integrationId: unknown, classification: unknown) {
  const id = yield* decodeJson(LocalId, integrationId)
  const config = yield* decodeJson(GithubClassificationConfiguration, classification)
  if (!sameSet(Object.keys(config.labels), [...config.categories])) return yield* invalid("Label mappings must cover every category exactly once")
  const actions: Record<string, ReadonlyArray<ActionStep>> = {}
  for (const category of config.categories) {
    const label = config.labels[category]
    if (label === undefined) return yield* invalid("Missing label mapping")
    actions[category] = [{
      id: `label-${category}`,
      action: githubLabelActionReference,
      integration: { id, definition: githubIntegrationReference },
      bindings: {
        issueNumber: fieldBinding(GithubIssuePayload, "trigger", ["issueNumber"]),
        label: literalBinding(label)
      }
    }]
  }
  return yield* decodeJson(ProcessDefinition, {
    schemaVersion: 1, kind: "process",
    trigger: { definition: githubTriggerReference, integration: { id, definition: githubIntegrationReference }, configuration: {} },
    decision: { kind: "jev", provider: "opencode-zen", model: "jev", version: "1.13", outcomes: [...config.categories] },
    actions
  })
})
export const githubClassificationTemplate = defineRoutine({
  definition: githubTemplateReference, title: "GitHub issue classification",
  configurationSchema: GithubClassificationConfiguration,
  process: Effect.runSync(buildGithubClassificationProcess("github", {
    categories: ["bug", "question"],
    labels: { bug: "type: bug", question: "type: question" },
    notifications: { onMatch: true, onNoMatch: true }
  }))
})
export const validateClassificationInput = Effect.fn("Automation.validateClassificationInput")(function*(input: unknown) {
  const parsed = yield* decodeJson(ClassificationInput, input)
  const classification = yield* decodeJson(GithubClassificationConfiguration, parsed.configuration)
  const process = yield* validateProcess(parsed.process)
  const triggerConfiguration = yield* decodeJson(GithubIssueTriggerConfiguration, process.trigger.configuration)
  if (Object.keys(triggerConfiguration).length > 0) return yield* invalid("Issue trigger takes no configuration")
  if (!sameDefinition(process.trigger.definition, githubTriggerReference)) return yield* invalid("Unknown classification trigger")
  const decision = process.decision
  if (decision === undefined || !sameSet(decision.outcomes, [...classification.categories])) return yield* invalid("Decision outcomes must match the configured categories")
  if (!sameSet(Object.keys(process.actions), [...classification.categories])) return yield* invalid("Action routes must match the configured categories")
  if (!sameSet(Object.keys(classification.labels), [...classification.categories])) return yield* invalid("Label mappings must cover every category exactly once")
  for (const integration of parsed.integrations) {
    if (!sameDefinition(integration.definition, githubIntegrationReference)) return yield* invalid("Unknown classification integration")
    yield* decodeJson(GithubRepositoryConfiguration, integration.configuration)
  }
  const triggerInstance = parsed.integrations.find((candidate) => candidate.id === process.trigger.integration.id)
  if (triggerInstance === undefined || !sameDefinition(triggerInstance.definition, process.trigger.integration.definition)) return yield* invalid("Missing configured trigger integration")
  for (const category of classification.categories) {
    const steps = process.actions[category]
    if (steps === undefined || steps.length !== 1) return yield* invalid("Every category needs exactly one label action")
    const label = classification.labels[category]
    if (label === undefined) return yield* invalid("Missing label mapping")
    const step = steps[0]!
    if (!sameDefinition(step.action, githubLabelActionReference)) return yield* invalid("Only the GitHub label action is allowed")
    const instance = parsed.integrations.find((candidate) => candidate.id === step.integration.id)
    if (instance === undefined || !sameDefinition(instance.definition, step.integration.definition)) return yield* invalid("Missing configured action integration")
    const keys = Object.keys(step.bindings).sort()
    if (keys.length !== 2 || keys[0] !== "issueNumber" || keys[1] !== "label") return yield* invalid("Label actions need an issue number and a label")
    const issueBinding = step.bindings["issueNumber"]!
    const labelBinding = step.bindings["label"]!
    if (issueBinding.kind !== "field" || issueBinding.source !== "trigger" || issueBinding.path.length !== 1 || issueBinding.path[0] !== "issueNumber") return yield* invalid("Label actions need the trigger issue number")
    if (labelBinding.kind !== "literal" || labelBinding.value !== label) return yield* invalid("Literal labels must use the mapped category label")
  }
  return { classification, process }
})
export type GithubLabelHandler = (args: typeof GithubLabelArguments.Type, configuration: typeof GithubRepositoryConfiguration.Type, context: InvocationContext) => Effect.Effect<typeof GithubLabelResult.Type, AutomationFailure>
export const makeGithubExtension = (handler: GithubLabelHandler = () => Effect.succeed({ applied: true })) => {
  const action = defineAction({
    definition: githubLabelActionReference, title: "GitHub label issue", integration: githubIntegrationReference,
    capabilities: ["label"], argumentsSchema: GithubLabelArguments, resultSchema: GithubLabelResult,
    integrationConfigurationSchema: GithubRepositoryConfiguration, handler
  })
  return { action, extension: defineExtension({ integrations: [githubIntegrationDefinition], triggers: [githubTriggerDefinition], actions: [action], routines: [githubClassificationTemplate] }) }
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
