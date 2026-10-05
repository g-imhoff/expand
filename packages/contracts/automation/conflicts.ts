import { Effect, Schema } from "effect"
import { AutomationError, decodeJson, IntegrationConfiguration, JsonValue } from "./descriptors.js"
import type { AutomationFailure, InvocationContext } from "./descriptors.js"
import { DefinitionReference, LocalId, sameDefinition } from "./ids.js"
import { fieldBinding, ProcessDefinition, validateProcess } from "./process.js"
import { defineAction, defineExtension, defineIntegration, defineTrigger } from "./extension.js"
export const GithubPrConflictPayload = Schema.Struct({
  pullNumber: Schema.Int.check(Schema.isGreaterThan(0)),
  headBranch: Schema.String.check(Schema.isMinLength(1)),
  baseBranch: Schema.String.check(Schema.isMinLength(1)),
  headSha: Schema.String.check(Schema.isMinLength(1)),
  mergeable: Schema.Boolean
})
export const GithubPrConflictConfiguration = Schema.Struct({
  owner: Schema.String.check(Schema.isMinLength(1)),
  repo: Schema.String.check(Schema.isMinLength(1)),
  permittedBranches: Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(Schema.isMinLength(1)),
  protectedBranches: Schema.Array(Schema.String.check(Schema.isMinLength(1))),
  defaultBranch: Schema.String.check(Schema.isMinLength(1))
})
export const GithubPrResolveArguments = Schema.Struct({
  pullNumber: Schema.Int.check(Schema.isGreaterThan(0)),
  headBranch: Schema.String.check(Schema.isMinLength(1)),
  baseBranch: Schema.String.check(Schema.isMinLength(1)),
  expectedHeadSha: Schema.String.check(Schema.isMinLength(1))
})
export const GithubPrResolveResult = Schema.Struct({
  resolved: Schema.Boolean,
  headSha: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  reason: Schema.optional(Schema.String.check(Schema.isMinLength(1)))
})
export const conflictIntegrationReference: DefinitionReference = { id: "github:pr-conflict-integration", version: 1 }
export const prConflictTriggerReference: DefinitionReference = { id: "github:pr-conflict", version: 1 }
export const prResolveActionReference: DefinitionReference = { id: "github:resolve-pr-conflict", version: 1 }
export const prConflictTemplateReference: DefinitionReference = { id: "github:pr-conflict-resolution", version: 1 }
export const conflictIntegrationDefinition = defineIntegration({
  definition: conflictIntegrationReference, title: "GitHub PR conflicts",
  capabilities: ["resolve"], configurationSchema: GithubPrConflictConfiguration
})
export const prConflictTriggerDefinition = defineTrigger({
  definition: prConflictTriggerReference, title: "GitHub PR conflict", integration: conflictIntegrationReference,
  configurationSchema: GithubPrConflictConfiguration, payloadSchema: GithubPrConflictPayload
})
export const buildPrConflictProcess = Effect.fn("Automation.buildPrConflictProcess")(function*(integrationId: unknown, triggerConfig: unknown) {
  const id = yield* decodeJson(LocalId, integrationId)
  yield* decodeJson(GithubPrConflictConfiguration, triggerConfig)
  return yield* decodeJson(ProcessDefinition, {
    schemaVersion: 1, kind: "process",
    trigger: { definition: prConflictTriggerReference, integration: { id, definition: conflictIntegrationReference }, configuration: triggerConfig },
    actions: {
      triggered: [{
        id: "resolve-conflict",
        action: prResolveActionReference,
        integration: { id, definition: conflictIntegrationReference },
        bindings: {
          pullNumber: fieldBinding(GithubPrConflictPayload, "trigger", ["pullNumber"]),
          headBranch: fieldBinding(GithubPrConflictPayload, "trigger", ["headBranch"]),
          baseBranch: fieldBinding(GithubPrConflictPayload, "trigger", ["baseBranch"]),
          expectedHeadSha: fieldBinding(GithubPrConflictPayload, "trigger", ["headSha"])
        }
      }]
    }
  })
})
export const prConflictTemplate = {
  definition: prConflictTemplateReference, title: "GitHub PR conflict resolution",
  configurationSchema: GithubPrConflictConfiguration,
  process: Effect.runSync(buildPrConflictProcess("github-conflicts", {
    owner: "octo",
    repo: "hello",
    permittedBranches: ["feature/"],
    protectedBranches: ["develop", "master", "main"],
    defaultBranch: "develop"
  }))
}
export const validateConflictInput = Effect.fn("Automation.validateConflictInput")(function*(input: unknown) {
  const parsed = yield* decodeJson(ClassificationInput, input)
  yield* decodeJson(GithubPrConflictConfiguration, parsed.configuration)
  const process = yield* validateProcess(parsed.process)
  if (!sameDefinition(process.trigger.definition, prConflictTriggerReference)) return yield* invalid("Unknown conflict trigger")
  if (process.decision !== undefined) return yield* invalid("Conflict process takes no decision")
  const steps = process.actions["triggered"]
  if (steps === undefined || steps.length !== 1) return yield* invalid("Conflict process needs exactly one resolve action")
  const step = steps[0]!
  if (!sameDefinition(step.action, prResolveActionReference)) return yield* invalid("Only the PR resolve action is allowed")
  const keys = Object.keys(step.bindings).sort()
  if (keys.length !== 4 || keys[0] !== "baseBranch" || keys[1] !== "expectedHeadSha" || keys[2] !== "headBranch" || keys[3] !== "pullNumber") return yield* invalid("Resolve actions need pull, branches and expected head")
  for (const integration of parsed.integrations) {
    if (!sameDefinition(integration.definition, conflictIntegrationReference)) return yield* invalid("Unknown conflict integration")
    yield* decodeJson(GithubPrConflictConfiguration, integration.configuration)
  }
  return { process }
})
export type GithubPrResolveHandler = (args: typeof GithubPrResolveArguments.Type, configuration: typeof GithubPrConflictConfiguration.Type, context: InvocationContext) => Effect.Effect<typeof GithubPrResolveResult.Type, AutomationFailure>
export const makeConflictExtension = (handler: GithubPrResolveHandler = () => Effect.succeed({ resolved: false, reason: "unresolved" })) => {
  const action = defineAction({
    definition: prResolveActionReference, title: "GitHub resolve PR conflict", integration: conflictIntegrationReference,
    capabilities: ["resolve"], argumentsSchema: GithubPrResolveArguments, resultSchema: GithubPrResolveResult,
    integrationConfigurationSchema: GithubPrConflictConfiguration, handler
  })
  return { action, extension: defineExtension({ integrations: [conflictIntegrationDefinition], triggers: [prConflictTriggerDefinition], actions: [action], routines: [] }) }
}
const ClassificationInput = Schema.Struct({
  configuration: JsonValue,
  integrations: Schema.Array(IntegrationConfiguration),
  process: ProcessDefinition
})
function invalid(message: string): AutomationError {
  return new AutomationError({ code: "invalid-reference", message })
}
