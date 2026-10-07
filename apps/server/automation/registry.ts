import { Effect, Schema, Semaphore } from "effect"
import {
  ActionDescriptor, AutomationError, Catalog, decodeJson, definitionKey, deriveSelectedActions, editorSchema,
  IntegrationConfiguration, IntegrationDescriptor, InvocationAuthority, JevDecisionResult, resolveActionArguments, RoutineConfiguration,
  RoutineDescriptor, sameDefinition, TriggerDescriptor, validateProcess
} from "@expand/contracts/automation"
import type {
  ActionSelection, AutomationExtension, DefinitionDescriptor, DefinitionReference, InstalledAction,
  IntegrationDefinition, RoutineDefinition, TriggerDefinition
} from "@expand/contracts/automation"

export interface SingleActionInvocation {
  readonly configuration: unknown
  readonly stepId: string
  readonly triggerPayload: unknown
  readonly decision?: unknown
  readonly mode: "preview" | "live"
}
export interface ResolvedSelection {
  readonly selection: ActionSelection
  readonly actions: ReadonlyArray<{ readonly stepId: string; readonly action: DefinitionReference; readonly integrationId: string; readonly arguments: Schema.Json }>
}

export class AutomationRegistry {
  private readonly registrationLock = Semaphore.makeUnsafe(1)
  private definitions = new Map<string, InstalledDefinition>()
  private descriptors: ReadonlyArray<DefinitionDescriptor> = []

  readonly register = Effect.fn("AutomationRegistry.register")(function*(this: AutomationRegistry, extension: AutomationExtension) {
    const pending = new Map(this.definitions)
    const descriptors: Array<DefinitionDescriptor> = []
    const additions = [...extension.integrations, ...extension.triggers, ...extension.actions, ...extension.routines].map(snapshotDefinition)
    for (const definition of additions) {
      const key = definitionKey(definition.definition)
      if (pending.has(key)) return yield* new AutomationError({ code: "duplicate-definition", message: `Definition already registered: ${key}` })
      pending.set(key, definition)
      descriptors.push(yield* describeDefinition(definition))
    }
    for (const definition of additions) {
      if (definition.kind === "trigger" || definition.kind === "action") {
        const integration = yield* requireDefinition(pending, definition.integration, "integration")
        if (definition.kind === "action") {
          for (const capability of definition.capabilities) {
            if (!integration.capabilities.includes(capability)) return yield* invalidReference("Action requires an undeclared integration capability")
          }
          if (definition.integrationConfigurationSchema !== integration.configurationSchema) {
            return yield* invalidReference("Action must share its integration definition's configuration codec")
          }
          yield* editorSchema(definition.integrationConfigurationSchema)
        }
      }
      if (definition.kind === "routine-template") yield* validateDefinitionReferences(pending, definition.process)
    }
    this.definitions = pending
    this.descriptors = [...this.descriptors, ...descriptors]
  }, (effect) => this.registrationLock.withPermit(effect))

  readonly catalog = (): Catalog => ({ schemaVersion: 1, kind: "catalog", definitions: structuredClone(this.descriptors) })

  readonly triggerPayloadSchema = Effect.fn("AutomationRegistry.triggerPayloadSchema")(function*(this: AutomationRegistry, reference: DefinitionReference) {
    const definition = yield* requireDefinition(this.definitions, reference, "trigger")
    return definition.payloadSchema
  })

  readonly validateIntegration = Effect.fn("AutomationRegistry.validateIntegration")(function*(this: AutomationRegistry, input: unknown) {
    const integration = yield* decodeJson(IntegrationConfiguration, input)
    const definition = yield* requireDefinition(this.definitions, integration.definition, "integration")
    yield* decodeJson(definition.configurationSchema, integration.configuration)
    return integration
  })

  readonly validateConfiguration = Effect.fn("AutomationRegistry.validateConfiguration")(function*(this: AutomationRegistry, input: unknown) {
    const configuration = yield* decodeJson(RoutineConfiguration, input)
    if (configuration.template !== undefined) {
      const routine = yield* requireDefinition(this.definitions, configuration.template, "routine-template")
      yield* decodeJson(routine.configurationSchema, configuration.configuration)
    }
    yield* validateDefinitionReferences(this.definitions, configuration.process)
    const integrationIds = new Set<string>()
    for (const integration of configuration.integrations) {
      if (integrationIds.has(integration.id)) return yield* invalidReference("Duplicate integration instance ID")
      integrationIds.add(integration.id)
      yield* this.validateIntegration(integration)
    }
    const trigger = yield* requireDefinition(this.definitions, configuration.process.trigger.definition, "trigger")
    yield* decodeJson(trigger.configurationSchema, configuration.process.trigger.configuration)
    yield* configuredIntegration(configuration, configuration.process.trigger.integration)
    for (const steps of Object.values(configuration.process.actions)) {
      for (const step of steps) yield* configuredIntegration(configuration, step.integration)
    }
    return configuration
  })

  readonly resolveSelectedActions = Effect.fn("AutomationRegistry.resolveSelectedActions")(function*(this: AutomationRegistry, input: unknown, triggerPayload: unknown, decisionInput?: unknown): Effect.fn.Return<ResolvedSelection, AutomationError> {
    const configuration = yield* this.validateConfiguration(input)
    const trigger = yield* requireDefinition(this.definitions, configuration.process.trigger.definition, "trigger")
    yield* decodeJson(trigger.payloadSchema, triggerPayload)
    const payload = yield* decodeJson(Schema.Json, triggerPayload)
    const selection = yield* deriveSelectedActions(configuration.process, decisionInput)
    const decision = decisionInput === undefined ? undefined : yield* decodeJson(JevDecisionResult, decisionInput)
    const actions: Array<ResolvedSelection["actions"][number]> = []
    for (const step of selection.actions) {
      const action = yield* requireDefinition(this.definitions, step.action, "action")
      const arguments_ = yield* resolveActionArguments(action.argumentsSchema, step.bindings, {
        trigger: payload, configuration: configuration.configuration,
        ...(decision?.kind === "selected" ? { decision: decision.data } : {})
      })
      actions.push({ stepId: step.id, action: step.action, integrationId: step.integration.id, arguments: arguments_.encoded })
    }
    return { selection, actions }
  })

  readonly invokeAction = Effect.fn("AutomationRegistry.invokeAction")(function*(this: AutomationRegistry, input: SingleActionInvocation, trustedAuthority: unknown) {
    const request = yield* decodeJson(InvocationRequest, input)
    const authority = yield* decodeJson(InvocationAuthority, trustedAuthority)
    const configuration = yield* this.validateConfiguration(request.configuration)
    if (authority.scope.ownerId !== configuration.scope.ownerId || authority.scope.projectId !== configuration.scope.projectId ||
      authority.configuration.routineId !== configuration.reference.routineId || authority.configuration.revision !== configuration.reference.revision) {
      return yield* denied("Authority does not match the personal scope and configuration revision")
    }
    const resolved = yield* this.resolveSelectedActions(configuration, request.triggerPayload, request.decision)
    if (resolved.selection.kind === "unresolved") return yield* new AutomationError({ code: "unresolved-selection", message: resolved.selection.reason })
    const selected = resolved.actions.find((action) => action.stepId === request.stepId)
    if (!selected) return yield* invalidReference("Action step is not in the selected outcome")
    const action = yield* requireDefinition(this.definitions, selected.action, "action")
    const hasGrant = authority.actionGrants.some((grant) => sameDefinition(grant.action, selected.action) &&
      grant.integrationId === selected.integrationId && action.capabilities.every((capability) => grant.capabilities.includes(capability)))
    if (!authority.integrationIds.includes(selected.integrationId) || !hasGrant) {
      return yield* denied("Authority does not grant this exact action version, integration and capabilities")
    }
    const integration = configuration.integrations.find((integration) => integration.id === selected.integrationId)
    if (!integration) return yield* invalidReference("Integration instance is not configured")
    yield* decodeJson(action.integrationConfigurationSchema, integration.configuration)
    const result = yield* action.invoke(selected.arguments, integration.configuration, {
      scope: configuration.scope, routineId: configuration.reference.routineId,
      configurationRevision: configuration.reference.revision, integrationId: integration.id, mode: request.mode
    })
    yield* decodeJson(action.resultSchema, result)
    return result
  })
}

type InstalledDefinition = IntegrationDefinition | TriggerDefinition | InstalledAction | RoutineDefinition
const InvocationRequest = Schema.Struct({
  configuration: RoutineConfiguration, stepId: Schema.String.check(Schema.isMinLength(1)), triggerPayload: Schema.Json,
  decision: Schema.optional(JevDecisionResult), mode: Schema.Literals(["preview", "live"])
})
const invalidReference = (message: string): AutomationError => new AutomationError({ code: "invalid-reference", message })
const denied = (message: string): AutomationError => new AutomationError({ code: "denied", message })
const requireDefinition = Effect.fn("AutomationRegistry.requireDefinition")(function*<K extends InstalledDefinition["kind"]>(
  definitions: ReadonlyMap<string, InstalledDefinition>, reference: DefinitionReference, kind: K
): Effect.fn.Return<Extract<InstalledDefinition, { kind: K }>, AutomationError> {
  const definition = definitions.get(definitionKey(reference))
  if (!definition || definition.kind !== kind) return yield* new AutomationError({ code: "missing-definition", message: `Missing ${kind}: ${definitionKey(reference)}` })
  return definition as Extract<InstalledDefinition, { kind: K }>
})
const configuredIntegration = Effect.fn("AutomationRegistry.configuredIntegration")(function*(
  configuration: RoutineConfiguration, reference: { readonly id: string; readonly definition: DefinitionReference }
) {
  const integration = configuration.integrations.find((integration) => integration.id === reference.id)
  if (!integration || !sameDefinition(integration.definition, reference.definition)) return yield* invalidReference("Missing exact configured integration reference")
  return integration
})
const validateDefinitionReferences = Effect.fn("AutomationRegistry.validateDefinitionReferences")(function*(
  definitions: ReadonlyMap<string, InstalledDefinition>, input: unknown
) {
  const process = yield* validateProcess(input)
  const trigger = yield* requireDefinition(definitions, process.trigger.definition, "trigger")
  yield* requireDefinition(definitions, process.trigger.integration.definition, "integration")
  if (!sameDefinition(trigger.integration, process.trigger.integration.definition)) return yield* invalidReference("Trigger integration definition does not match")
  for (const steps of Object.values(process.actions)) {
    for (const step of steps) {
      const action = yield* requireDefinition(definitions, step.action, "action")
      yield* requireDefinition(definitions, step.integration.definition, "integration")
      if (!sameDefinition(action.integration, step.integration.definition)) return yield* invalidReference("Action integration definition does not match")
    }
  }
  return process
})
const describeDefinition = Effect.fn("AutomationRegistry.describeDefinition")(function*(definition: InstalledDefinition): Effect.fn.Return<DefinitionDescriptor, AutomationError> {
  const common = { schemaVersion: 1 as const, definition: definition.definition, title: definition.title }
  switch (definition.kind) {
    case "integration":
      return yield* decodeJson(IntegrationDescriptor, { ...common, kind: definition.kind, capabilities: definition.capabilities, configurationSchema: yield* editorSchema(definition.configurationSchema) })
    case "trigger":
      return yield* decodeJson(TriggerDescriptor, { ...common, kind: definition.kind, integration: definition.integration,
        configurationSchema: yield* editorSchema(definition.configurationSchema), payloadSchema: yield* editorSchema(definition.payloadSchema) })
    case "action":
      return yield* decodeJson(ActionDescriptor, { ...common, kind: definition.kind, integration: definition.integration, capabilities: definition.capabilities,
        argumentsSchema: yield* editorSchema(definition.argumentsSchema), resultSchema: yield* editorSchema(definition.resultSchema) })
    case "routine-template":
      return yield* decodeJson(RoutineDescriptor, { ...common, kind: definition.kind, configurationSchema: yield* editorSchema(definition.configurationSchema), process: definition.process })
  }
})

const snapshotDefinition = (definition: InstalledDefinition): InstalledDefinition => {
  const common = { ...definition, definition: { ...definition.definition } }
  switch (definition.kind) {
    case "integration": return { ...definition, ...common, kind: definition.kind, capabilities: [...definition.capabilities] }
    case "trigger": return { ...definition, ...common, kind: definition.kind, integration: { ...definition.integration } }
    case "action": return { ...definition, ...common, kind: definition.kind, integration: { ...definition.integration }, capabilities: [...definition.capabilities] }
    case "routine-template": return { ...definition, ...common, kind: definition.kind, process: structuredClone(definition.process) }
  }
}
