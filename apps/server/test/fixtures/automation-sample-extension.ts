import { Effect, Schema } from "effect"
import { defineAction, defineExtension, defineIntegration, defineRoutine, defineTrigger, fieldBinding } from "@expand/contracts/automation"
import type { AutomationFailure, InvocationAuthority, InvocationContext, ProcessDefinition, RoutineConfiguration } from "@expand/contracts/automation"

export const SampleIntegrationConfiguration = Schema.Struct({ mailbox: Schema.String.check(Schema.isMinLength(1)) })
export const SamplePayload = Schema.Struct({ subject: Schema.String, count: Schema.FiniteFromString })
export const SampleArguments = Schema.Struct({ message: Schema.String.check(Schema.isMinLength(1)), count: Schema.FiniteFromString })
export const SampleResult = Schema.Struct({ summary: Schema.String, total: Schema.Finite })
export const sampleIntegration = defineIntegration({
  definition: { id: "sample:mail", version: 1 }, title: "Fictitious mail", capabilities: ["send"],
  configurationSchema: SampleIntegrationConfiguration
})
export const sampleTrigger = defineTrigger({
  definition: { id: "sample:received", version: 1 }, title: "Fictitious received", integration: sampleIntegration.definition,
  configurationSchema: Schema.Struct({ label: Schema.optional(Schema.String) }), payloadSchema: SamplePayload
})
export const sampleRoutine = defineRoutine({
  definition: { id: "sample:routine", version: 1 }, title: "Fictitious routine",
  configurationSchema: Schema.Struct({ prefix: Schema.String, format: Schema.optional(Schema.Literals(["plain", "rich"])) }), process: makeSampleProcess()
})
export type SampleHandler = (args: typeof SampleArguments.Type, configuration: typeof SampleIntegrationConfiguration.Type, context: InvocationContext) => Effect.Effect<typeof SampleResult.Type, AutomationFailure>
export const makeSampleExtension = (handler: SampleHandler = (args, config) => Effect.succeed({ summary: `${config.mailbox}: ${args.message}`, total: args.count })) => {
  const action = defineAction({
    definition: { id: "sample:send", version: 1 }, title: "Fictitious send", integration: sampleIntegration.definition,
    capabilities: ["send"], argumentsSchema: SampleArguments, resultSchema: SampleResult,
    integrationConfigurationSchema: SampleIntegrationConfiguration, handler
  })
  return { action, extension: defineExtension({ integrations: [sampleIntegration], triggers: [sampleTrigger], actions: [action], routines: [sampleRoutine] }) }
}
export const sampleConfiguration: RoutineConfiguration = {
  schemaVersion: 1, kind: "routine-configuration", reference: { routineId: "personal-mail", revision: 2 },
  template: sampleRoutine.definition, scope: { ownerId: "person", projectId: "project" }, configuration: { prefix: "Hello" },
  integrations: [{ schemaVersion: 1, kind: "integration-configuration", id: "mail", definition: sampleIntegration.definition,
    configuration: { mailbox: "inbox" }, credentials: { account: { schemaVersion: 1, kind: "credential-reference", credentialId: "account-1" } } }],
  process: sampleRoutine.process
}
export const sampleAuthority: InvocationAuthority = {
  schemaVersion: 1, kind: "invocation-authority", scope: sampleConfiguration.scope, configuration: sampleConfiguration.reference,
  integrationIds: ["mail"], actionGrants: [{ action: { id: "sample:send", version: 1 }, integrationId: "mail", capabilities: ["send"] }]
}

function makeSampleProcess(): ProcessDefinition {
  return {
  schemaVersion: 1, kind: "process", trigger: {
    definition: sampleTrigger.definition, integration: { id: "mail", definition: sampleIntegration.definition }, configuration: {}
  }, actions: { triggered: [{
    id: "send", action: { id: "sample:send", version: 1 }, integration: { id: "mail", definition: sampleIntegration.definition },
    bindings: { message: fieldBinding(SamplePayload, "trigger", ["subject"]), count: fieldBinding(SamplePayload, "trigger", ["count"]) }
  }] }
}
}
