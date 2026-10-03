import { Context, Effect, Layer, Schema } from "effect"
import { AutomationError, decodeJson, LocalId, PersonalScope, RoutineConfiguration, sameDefinition } from "@expand/contracts/automation"
import type { DefinitionReference, IntegrationConfiguration } from "@expand/contracts/automation"
import { githubTemplateReference, githubTriggerReference, validateClassificationInput } from "@expand/contracts/automation/github"
import { AutomationRegistry } from "./registry.js"
import { ConfigurationRepository } from "./configuration-repository.js"
import type { ListedRoutine, RoutineHead } from "./configuration-repository.js"
import { CredentialRepository } from "./credential-repository.js"
import type { CredentialStatus } from "./credential-repository.js"
import { RoutineStatus, StorageError, same } from "./persistence-models.js"

export interface RoutineEdit {
  readonly template?: DefinitionReference
  readonly configuration: Schema.Json
  readonly integrations: ReadonlyArray<unknown>
  readonly process: unknown
}
export interface RoutineInput extends RoutineEdit { readonly routineId: string }
export interface RoutineRead {
  readonly routineId: string
  readonly head: RoutineHead
  readonly configuration: RoutineConfiguration
  readonly credentials: ReadonlyArray<CredentialStatus>
}
export class RoutineService extends Context.Service<RoutineService, {
  readonly create: (scope: PersonalScope, input: RoutineInput) => Effect.Effect<number, AutomationError | StorageError>
  readonly edit: (scope: PersonalScope, routineId: string, input: RoutineEdit) => Effect.Effect<number, AutomationError | StorageError>
  readonly enable: (scope: PersonalScope, routineId: string, expectedVersion: number) => Effect.Effect<RoutineHead, AutomationError | StorageError>
  readonly pause: (scope: PersonalScope, routineId: string, expectedVersion: number) => Effect.Effect<RoutineHead, AutomationError | StorageError>
  readonly remove: (scope: PersonalScope, routineId: string, expectedVersion: number) => Effect.Effect<RoutineHead, AutomationError | StorageError>
  readonly get: (scope: PersonalScope, routineId: string) => Effect.Effect<RoutineRead | null, AutomationError | StorageError>
  readonly list: (scope: PersonalScope) => Effect.Effect<ReadonlyArray<RoutineRead>, AutomationError | StorageError>
  readonly due: (scope: PersonalScope) => Effect.Effect<ReadonlyArray<RoutineRead>, AutomationError | StorageError>
  readonly assertDue: (scope: PersonalScope, routineId: string) => Effect.Effect<RoutineRead, AutomationError | StorageError>
}>()("expand/RoutineService") {}
export const isExecutableStatus = (status: RoutineStatus): boolean => status === "enabled"
export const RoutineServiceLayer = (registry: AutomationRegistry): Layer.Layer<RoutineService, never, ConfigurationRepository | CredentialRepository> =>
  Layer.effect(RoutineService, Effect.gen(function* () {
    const configuration = yield* ConfigurationRepository
    const credentials = yield* CredentialRepository
    const buildConfiguration = Effect.fn("RoutineService.buildConfiguration")(function*(scope: PersonalScope, routineId: string, revision: number, input: RoutineEdit) {
      const value = yield* decodeJson(RoutineConfiguration, {
        schemaVersion: 1, kind: "routine-configuration", reference: { routineId, revision }, scope,
        configuration: input.configuration, integrations: [...input.integrations], process: input.process,
        ...(input.template === undefined ? {} : { template: input.template })
      })
      yield* registry.validateConfiguration(value)
      if (value.template !== undefined && sameDefinition(value.template, githubTemplateReference) && !sameDefinition(value.process.trigger.definition, githubTriggerReference)) {
        return yield* new AutomationError({ code: "invalid-reference", message: "Template process must use the GitHub issue trigger" })
      }
      if (sameDefinition(value.process.trigger.definition, githubTriggerReference)) {
        yield* validateClassificationInput({ configuration: value.configuration, integrations: value.integrations, process: value.process })
      }
      for (const integration of value.integrations) {
        for (const reference of Object.values(integration.credentials)) {
          const status = yield* credentials.getStatus(scope, reference.credentialId)
          if (status === null) return yield* new StorageError({ code: "missing", message: "Credential reference is not configured" })
        }
      }
      return value
    })
    const syncIntegrations = Effect.fn("RoutineService.syncIntegrations")(function*(scope: PersonalScope, integrations: ReadonlyArray<IntegrationConfiguration>) {
      for (const integration of integrations) {
        const existing = yield* configuration.getIntegration(scope, integration.id)
        if (existing === null) yield* configuration.putIntegration(scope, integration, 0)
        else if (!same(existing.configuration, integration)) return yield* new StorageError({ code: "conflict", message: "Integration instance differs from stored configuration" })
      }
    })
    const readRoutine = Effect.fn("RoutineService.readRoutine")(function*(scope: PersonalScope, routineId: string, head: RoutineHead) {
      const value = yield* configuration.getRevision(scope, routineId, head.revision)
      if (value === null) return yield* new StorageError({ code: "missing", message: "Routine revision is missing" })
      const statuses: Array<CredentialStatus> = []
      for (const integration of value.integrations) {
        for (const reference of Object.values(integration.credentials)) {
          const status = yield* credentials.getStatus(scope, reference.credentialId)
          if (status !== null) statuses.push(status)
        }
      }
      return { routineId, head, configuration: value, credentials: statuses }
    })
    const loadHead = Effect.fn("RoutineService.loadHead")(function*(scope: PersonalScope, routineId: string) {
      yield* decodeJson(LocalId, routineId)
      return yield* configuration.getHead(scope, routineId)
    })
    const readListed = Effect.fn("RoutineService.readListed")(function*(scope: PersonalScope, listed: ListedRoutine) {
      return yield* readRoutine(scope, listed.routineId, listed.head)
    })
    const create = Effect.fn("RoutineService.create")(function*(scope: PersonalScope, input: RoutineInput) {
      const head = yield* loadHead(scope, input.routineId)
      if (head !== null) return yield* new StorageError({ code: "conflict", message: "Routine already exists" })
      const value = yield* buildConfiguration(scope, input.routineId, 1, input)
      yield* syncIntegrations(scope, value.integrations)
      return yield* configuration.appendRoutineRevision(value, 0, "enabled")
    })
    const edit = Effect.fn("RoutineService.edit")(function*(scope: PersonalScope, routineId: string, input: RoutineEdit) {
      const head = yield* loadHead(scope, routineId)
      if (head === null) return yield* new StorageError({ code: "missing", message: "Routine does not exist" })
      if (head.status === "deleted") return yield* new AutomationError({ code: "invalid-reference", message: "Routine is deleted" })
      const value = yield* buildConfiguration(scope, routineId, head.revision + 1, input)
      yield* syncIntegrations(scope, value.integrations)
      return yield* configuration.appendRoutineRevision(value, head.revision, head.status)
    })
    const setStatus = (status: RoutineStatus) => Effect.fn(`RoutineService.${status}`)(function*(scope: PersonalScope, routineId: string, expectedVersion: number) {
      yield* decodeJson(LocalId, routineId)
      return yield* configuration.setStatus(scope, routineId, status, expectedVersion)
    })
    const get = Effect.fn("RoutineService.get")(function*(scope: PersonalScope, routineId: string) {
      const head = yield* loadHead(scope, routineId)
      if (head === null) return null
      return yield* readRoutine(scope, routineId, head)
    })
    const list = Effect.fn("RoutineService.list")(function*(scope: PersonalScope) {
      const heads = yield* configuration.listHeads(scope)
      const routines: Array<RoutineRead> = []
      for (const listed of heads) routines.push(yield* readListed(scope, listed))
      return routines as ReadonlyArray<RoutineRead>
    })
    const due = Effect.fn("RoutineService.due")(function*(scope: PersonalScope) {
      const routines = yield* list(scope)
      return routines.filter((routine) => isExecutableStatus(routine.head.status))
    })
    const assertDue = Effect.fn("RoutineService.assertDue")(function*(scope: PersonalScope, routineId: string) {
      const routine = yield* get(scope, routineId)
      if (routine === null) return yield* new StorageError({ code: "missing", message: "Routine does not exist" })
      if (!isExecutableStatus(routine.head.status)) return yield* new StorageError({ code: "invalid", message: "Routine is not enabled for execution" })
      return routine
    })
    return { create, edit, enable: setStatus("enabled"), pause: setStatus("paused"), remove: setStatus("deleted"), get, list, due, assertDue }
  }))
