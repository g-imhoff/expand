import { Effect, Schema } from "effect"
import { AutomationError, decodeJson, IntegrationConfiguration, JsonValue } from "./descriptors.js"
import type { AutomationFailure, InvocationContext } from "./descriptors.js"
import { DefinitionReference, LocalId, sameDefinition } from "./ids.js"
import { fieldBinding, ProcessDefinition, validateProcess } from "./process.js"
import type { ActionStep } from "./process.js"
import { defineAction, defineExtension, defineIntegration, defineRoutine, defineTrigger } from "./extension.js"
import { codingIntegrationReference, CodingRepositoryConfiguration } from "./coding.js"
import { skillActionReference } from "./skills.js"

export const SonarQubeProjectConfiguration = Schema.Struct({
  baseUrl: Schema.String.check(Schema.isMinLength(1)),
  projectKey: Schema.String.check(Schema.isMinLength(1))
})
export const SonarQubeFindingTriggerConfiguration = Schema.Struct({})
export const SonarQubeFindingPayload = Schema.Struct({
  issueKey: Schema.String.check(Schema.isMinLength(1)),
  projectKey: Schema.String.check(Schema.isMinLength(1)),
  rule: Schema.String.check(Schema.isMinLength(1)),
  severity: Schema.String.check(Schema.isMinLength(1)),
  file: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  line: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  message: Schema.optional(Schema.String.check(Schema.isMinLength(1)))
})
export const SonarQubeFetchArguments = Schema.Struct({
  issueKey: Schema.String.check(Schema.isMinLength(1))
})
export const SonarQubeFindingResult = Schema.Struct({
  issueKey: Schema.String.check(Schema.isMinLength(1)),
  status: Schema.String.check(Schema.isMinLength(1)),
  severity: Schema.String.check(Schema.isMinLength(1)),
  rule: Schema.String.check(Schema.isMinLength(1)),
  message: Schema.String.check(Schema.isMinLength(1))
})
export const SonarQubeVerifyArguments = Schema.Struct({
  issueKey: Schema.String.check(Schema.isMinLength(1))
})
export const SonarQubeVerifyResult = Schema.Struct({
  issueKey: Schema.String.check(Schema.isMinLength(1)),
  resolved: Schema.Boolean,
  status: Schema.String.check(Schema.isMinLength(1))
})
export const SonarQubeAutoFixConfiguration = Schema.Struct({
  repairSkillId: LocalId,
  repairInputs: JsonValue,
  agentKind: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  timeoutMs: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(300000)))
})
export const sonarIntegrationReference: DefinitionReference = { id: "sonarqube:integration", version: 1 }
export const sonarFindingTriggerReference: DefinitionReference = { id: "sonarqube:finding-opened", version: 1 }
export const sonarFetchActionReference: DefinitionReference = { id: "sonarqube:fetch-finding", version: 1 }
export const sonarVerifyActionReference: DefinitionReference = { id: "sonarqube:verify-fixed", version: 1 }
export const sonarTemplateReference: DefinitionReference = { id: "sonarqube:auto-fix", version: 1 }
export const sonarIntegrationDefinition = defineIntegration({
  definition: sonarIntegrationReference, title: "SonarQube", capabilities: ["read", "verify"],
  configurationSchema: SonarQubeProjectConfiguration
})
export const sonarFindingTriggerDefinition = defineTrigger({
  definition: sonarFindingTriggerReference, title: "SonarQube finding opened", integration: sonarIntegrationReference,
  configurationSchema: SonarQubeFindingTriggerConfiguration, payloadSchema: SonarQubeFindingPayload
})
export const buildSonarAutoFixProcess = Effect.fn("Automation.buildSonarAutoFixProcess")(function*(
  sonarIntegrationId: unknown,
  codingIntegrationId: unknown,
  configuration: unknown
) {
  const sonarId = yield* decodeJson(LocalId, sonarIntegrationId)
  const codingId = yield* decodeJson(LocalId, codingIntegrationId)
  const config = yield* decodeJson(SonarQubeAutoFixConfiguration, configuration)
  const repairBindings: Record<string, { readonly kind: "field", readonly source: "trigger" | "configuration" | "decision", readonly path: ReadonlyArray<string> }> = {
    skillId: fieldBinding(SonarQubeAutoFixConfiguration, "configuration", ["repairSkillId"]),
    inputs: fieldBinding(SonarQubeAutoFixConfiguration, "configuration", ["repairInputs"])
  }
  const withOptional: Record<string, { readonly kind: "field", readonly source: "trigger" | "configuration" | "decision", readonly path: ReadonlyArray<string> }> = { ...repairBindings }
  if (config.agentKind !== undefined) {
    withOptional["agentKind"] = fieldBinding(SonarQubeAutoFixConfiguration, "configuration", ["agentKind"])
  }
  if (config.timeoutMs !== undefined) {
    withOptional["timeoutMs"] = fieldBinding(SonarQubeAutoFixConfiguration, "configuration", ["timeoutMs"])
  }
  return yield* decodeJson(ProcessDefinition, {
    schemaVersion: 1, kind: "process",
    trigger: { definition: sonarFindingTriggerReference, integration: { id: sonarId, definition: sonarIntegrationReference }, configuration: {} },
    actions: {
      triggered: [
        {
          id: "fetch-finding",
          action: sonarFetchActionReference,
          integration: { id: sonarId, definition: sonarIntegrationReference },
          bindings: {
            issueKey: fieldBinding(SonarQubeFindingPayload, "trigger", ["issueKey"])
          }
        },
        {
          id: "repair-finding",
          action: { ...skillActionReference },
          integration: { id: codingId, definition: { ...codingIntegrationReference } },
          bindings: { ...withOptional }
        },
        {
          id: "verify-fixed",
          action: sonarVerifyActionReference,
          integration: { id: sonarId, definition: sonarIntegrationReference },
          bindings: {
            issueKey: fieldBinding(SonarQubeFindingPayload, "trigger", ["issueKey"])
          }
        }
      ]
    }
  })
})
export const sonarAutoFixTemplate = defineRoutine({
  definition: sonarTemplateReference, title: "SonarQube auto fix",
  configurationSchema: SonarQubeAutoFixConfiguration,
  process: Effect.runSync(buildSonarAutoFixProcess("sonar", "coding", {
    repairSkillId: "sample-write-file",
    repairInputs: { content: "fix" }
  }))
})
export const validateSonarAutoFixInput = Effect.fn("Automation.validateSonarAutoFixInput")(function*(input: unknown) {
  const parsed = yield* decodeJson(ClassificationInput, input)
  const configuration = yield* decodeJson(SonarQubeAutoFixConfiguration, parsed.configuration)
  const process = yield* validateProcess(parsed.process)
  if (process.decision !== undefined) return yield* invalid("SonarQube auto fix takes no decision")
  if (!sameDefinition(process.trigger.definition, sonarFindingTriggerReference)) return yield* invalid("Unknown SonarQube trigger")
  const triggerConfiguration = yield* decodeJson(SonarQubeFindingTriggerConfiguration, process.trigger.configuration)
  if (Object.keys(triggerConfiguration).length > 0) return yield* invalid("Finding trigger takes no configuration")
  for (const integration of parsed.integrations) {
    if (sameDefinition(integration.definition, sonarIntegrationReference)) {
      yield* decodeJson(SonarQubeProjectConfiguration, integration.configuration)
    } else if (sameDefinition(integration.definition, codingIntegrationReference)) {
      yield* decodeJson(CodingRepositoryConfiguration, integration.configuration)
    } else {
      return yield* invalid("Unknown SonarQube auto fix integration")
    }
  }
  const sonarInstance = parsed.integrations.find((candidate) => sameDefinition(candidate.definition, sonarIntegrationReference))
  const codingInstance = parsed.integrations.find((candidate) => sameDefinition(candidate.definition, codingIntegrationReference))
  if (sonarInstance === undefined) return yield* invalid("Missing SonarQube integration")
  if (codingInstance === undefined) return yield* invalid("Missing coding integration for the repair skill")
  if (process.trigger.integration.id !== sonarInstance.id) return yield* invalid("Missing configured trigger integration")
  if (!sameDefinition(process.trigger.integration.definition, sonarIntegrationReference)) return yield* invalid("Trigger integration definition does not match")
  const steps = process.actions["triggered"]
  if (steps === undefined || steps.length !== 3) return yield* invalid("SonarQube auto fix needs fetch, repair and verify steps")
  const outcomeKeys = Object.keys(process.actions)
  if (outcomeKeys.length !== 1 || outcomeKeys[0] !== "triggered") return yield* invalid("SonarQube auto fix supports only the triggered outcome")
  const fetchStep = steps[0]!
  const repairStep = steps[1]!
  const verifyStep = steps[2]!
  if (!sameDefinition(fetchStep.action, sonarFetchActionReference)) return yield* invalid("First step must fetch the SonarQube finding")
  if (!sameDefinition(repairStep.action, skillActionReference)) return yield* invalid("Second step must run the configured repair skill")
  if (!sameDefinition(verifyStep.action, sonarVerifyActionReference)) return yield* invalid("Third step must verify the SonarQube finding")
  if (fetchStep.id !== "fetch-finding") return yield* invalid("Fetch step id is not usable")
  if (repairStep.id !== "repair-finding") return yield* invalid("Repair step id is not usable")
  if (verifyStep.id !== "verify-fixed") return yield* invalid("Verify step id is not usable")
  if (!sameDefinition(fetchStep.integration.definition, sonarIntegrationReference) || fetchStep.integration.id !== sonarInstance.id) return yield* invalid("Fetch integration is not usable")
  if (!sameDefinition(verifyStep.integration.definition, sonarIntegrationReference) || verifyStep.integration.id !== sonarInstance.id) return yield* invalid("Verify integration is not usable")
  if (!sameDefinition(repairStep.integration.definition, codingIntegrationReference) || repairStep.integration.id !== codingInstance.id) return yield* invalid("Repair integration is not usable")
  yield* expectField(fetchStep, "issueKey", "trigger", ["issueKey"])
  yield* expectField(verifyStep, "issueKey", "trigger", ["issueKey"])
  yield* expectField(repairStep, "skillId", "configuration", ["repairSkillId"])
  yield* expectField(repairStep, "inputs", "configuration", ["repairInputs"])
  const repairKeys = Object.keys(repairStep.bindings).sort()
  for (const key of repairKeys) {
    if (key !== "skillId" && key !== "inputs" && key !== "agentKind" && key !== "timeoutMs") return yield* invalid("Repair step has an unsupported binding")
  }
  if (configuration.agentKind !== undefined) {
    if (repairStep.bindings["agentKind"] === undefined) return yield* invalid("Repair agent kind is not bound")
    yield* expectField(repairStep, "agentKind", "configuration", ["agentKind"])
  } else if (repairStep.bindings["agentKind"] !== undefined) {
    return yield* invalid("Repair agent kind must match the configured value")
  }
  if (configuration.timeoutMs !== undefined) {
    if (repairStep.bindings["timeoutMs"] === undefined) return yield* invalid("Repair timeout is not bound")
    yield* expectField(repairStep, "timeoutMs", "configuration", ["timeoutMs"])
  } else if (repairStep.bindings["timeoutMs"] !== undefined) {
    return yield* invalid("Repair timeout must match the configured value")
  }
  const fetchKeys = Object.keys(fetchStep.bindings).sort()
  if (fetchKeys.length !== 1 || fetchKeys[0] !== "issueKey") return yield* invalid("Fetch step needs only the issue key")
  const verifyKeys = Object.keys(verifyStep.bindings).sort()
  if (verifyKeys.length !== 1 || verifyKeys[0] !== "issueKey") return yield* invalid("Verify step needs only the issue key")
  return { configuration, process }
})
export type SonarFetchHandler = (args: typeof SonarQubeFetchArguments.Type, configuration: typeof SonarQubeProjectConfiguration.Type, context: InvocationContext) => Effect.Effect<typeof SonarQubeFindingResult.Type, AutomationFailure>
export type SonarVerifyHandler = (args: typeof SonarQubeVerifyArguments.Type, configuration: typeof SonarQubeProjectConfiguration.Type, context: InvocationContext) => Effect.Effect<typeof SonarQubeVerifyResult.Type, AutomationFailure>
export const makeSonarExtension = (fetchHandler: SonarFetchHandler = () => Effect.succeed({ issueKey: "issue-1", status: "OPEN", severity: "MAJOR", rule: "rule-1", message: "finding" }), verifyHandler: SonarVerifyHandler = () => Effect.succeed({ issueKey: "issue-1", resolved: true, status: "CLOSED" })) => {
  const fetchAction = defineAction({
    definition: sonarFetchActionReference, title: "SonarQube fetch finding", integration: sonarIntegrationReference,
    capabilities: ["read"], argumentsSchema: SonarQubeFetchArguments, resultSchema: SonarQubeFindingResult,
    integrationConfigurationSchema: SonarQubeProjectConfiguration, handler: fetchHandler
  })
  const verifyAction = defineAction({
    definition: sonarVerifyActionReference, title: "SonarQube verify fixed", integration: sonarIntegrationReference,
    capabilities: ["verify"], argumentsSchema: SonarQubeVerifyArguments, resultSchema: SonarQubeVerifyResult,
    integrationConfigurationSchema: SonarQubeProjectConfiguration, handler: verifyHandler
  })
  return { fetchAction, verifyAction, extension: defineExtension({ integrations: [sonarIntegrationDefinition], triggers: [sonarFindingTriggerDefinition], actions: [fetchAction, verifyAction], routines: [sonarAutoFixTemplate] }) }
}
const ClassificationInput = Schema.Struct({
  configuration: JsonValue,
  integrations: Schema.Array(IntegrationConfiguration),
  process: ProcessDefinition
})
const expectField = Effect.fn("Automation.expectSonarField")(function*(step: ActionStep, argument: string, source: "trigger" | "configuration", path: ReadonlyArray<string>) {
  const binding = step.bindings[argument]
  if (binding === undefined || binding.kind !== "field" || binding.source !== source || binding.path.length !== path.length || !binding.path.every((part, index) => part === path[index])) {
    return yield* invalid(`Binding for ${argument} is not usable`)
  }
})
function invalid(message: string): AutomationError {
  return new AutomationError({ code: "invalid-reference", message })
}
