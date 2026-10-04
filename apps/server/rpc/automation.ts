import { DateTime, Effect } from "effect"
import type { RpcGroup } from "effect/rpc"
import { ExpandRpcs } from "@expand/contracts/rpc"
import {
  AutomationConflict,
  AutomationInvalid,
  AutomationNotFound,
  AutomationStorageFailed
} from "@expand/contracts/rpc/automation-schemas"
import type { AutomationEvent } from "@expand/contracts/events/automation"
import {
  AutomationCredentialChanged,
  AutomationIntegrationChanged,
  AutomationRoutineChanged
} from "@expand/contracts/events/automation"
import { decodeJson, RoutineConfiguration } from "@expand/contracts/automation"
import type { AutomationError } from "@expand/contracts/automation"
import type { PersonalScope } from "@expand/contracts/automation"
import { ConfigurationRepository } from "@expand/server/automation/configuration-repository"
import { CredentialRepository } from "@expand/server/automation/credential-repository"
import { emitAutomationEvent } from "@expand/server/automation/event-store"
import { ExecutionRepository } from "@expand/server/automation/execution-repository"

import { checkGithubConnection } from "@expand/server/automation/github-connector"
import { runIssueClassification } from "@expand/server/automation/issue-classification"
import { StorageError } from "@expand/server/automation/persistence-models"
import { AutomationRegistryService } from "@expand/server/automation/registry-service"
import { RoutineService } from "@expand/server/automation/routine-service"
import { guard } from "@expand/server/rpc/guard"

export const automationHandlers = {
  AutomationRoutineCreate: ({ scope, routineId, template, configuration, integrations, process }) =>
    guard(Effect.gen(function*() {
      const routines = yield* RoutineService
      const revision = yield* routines.create(scope, {
        routineId,
        ...(template === undefined ? {} : { template }),
        configuration,
        integrations,
        process
      }).pipe(Effect.mapError(toRpcError))
      yield* emitRoutine(scope, routineId, revision, "enabled")
      return { revision }
    })),
  AutomationRoutineEdit: ({ scope, routineId, template, configuration, integrations, process }) =>
    guard(Effect.gen(function*() {
      const routines = yield* RoutineService
      const revision = yield* routines.edit(scope, routineId, {
        ...(template === undefined ? {} : { template }),
        configuration,
        integrations,
        process
      }).pipe(Effect.mapError(toRpcError))
      const current = yield* routines.get(scope, routineId).pipe(Effect.mapError(toRpcError))
      if (current === null) return yield* new AutomationNotFound({ code: "missing", message: "Routine does not exist" })
      yield* emitRoutine(scope, routineId, revision, current.head.status)
      return { revision }
    })),
  AutomationRoutineEnable: ({ scope, routineId, expectedVersion }) =>
    guard(Effect.gen(function*() {
      const routines = yield* RoutineService
      const head = yield* routines.enable(scope, routineId, expectedVersion).pipe(Effect.mapError(toRpcError))
      yield* emitRoutine(scope, routineId, head.revision, head.status)
      return head
    })),
  AutomationRoutinePause: ({ scope, routineId, expectedVersion }) =>
    guard(Effect.gen(function*() {
      const routines = yield* RoutineService
      const head = yield* routines.pause(scope, routineId, expectedVersion).pipe(Effect.mapError(toRpcError))
      yield* emitRoutine(scope, routineId, head.revision, head.status)
      return head
    })),
  AutomationRoutineDelete: ({ scope, routineId, expectedVersion }) =>
    guard(Effect.gen(function*() {
      const routines = yield* RoutineService
      const head = yield* routines.remove(scope, routineId, expectedVersion).pipe(Effect.mapError(toRpcError))
      yield* emitRoutine(scope, routineId, head.revision, head.status)
      return head
    })),
  AutomationRoutineGet: ({ scope, routineId }) =>
    guard(Effect.gen(function*() {
      const routines = yield* RoutineService
      const routine = yield* routines.get(scope, routineId).pipe(Effect.mapError(toRpcError))
      if (routine === null) return yield* new AutomationNotFound({ code: "missing", message: "Routine does not exist" })
      return routine
    })),
  AutomationRoutineList: ({ scope }) =>
    guard(Effect.gen(function*() {
      const routines = yield* RoutineService
      const found = yield* routines.list(scope).pipe(Effect.mapError(toRpcError))
      return { routines: [...found] }
    })),
  AutomationIntegrationPut: ({ scope, integration, expectedVersion }) =>
    guard(Effect.gen(function*() {
      const configurations = yield* ConfigurationRepository
      const version = yield* configurations.putIntegration(scope, integration, expectedVersion ?? 0).pipe(
        Effect.mapError(toRpcError)
      )
      yield* emit(AutomationIntegrationChanged.make({
        projectId: scope.projectId,
        ownerId: scope.ownerId,
        integrationId: integration.id,
        occurredAt: yield* nowIso
      }))
      return { version }
    })),
  AutomationIntegrationGet: ({ scope, integrationId }) =>
    guard(Effect.gen(function*() {
      const configurations = yield* ConfigurationRepository
      const stored = yield* configurations.getIntegration(scope, integrationId).pipe(Effect.mapError(toRpcError))
      if (stored === null) return yield* new AutomationNotFound({ code: "missing", message: "Integration is not configured" })
      return stored
    })),
  AutomationIntegrationStatus: ({ scope, integrationId }) =>
    guard(Effect.gen(function*() {
      const configurations = yield* ConfigurationRepository
      const stored = yield* configurations.getIntegration(scope, integrationId).pipe(Effect.mapError(toRpcError))
      if (stored === null) return yield* new AutomationNotFound({ code: "missing", message: "Integration is not configured" })
      const status = yield* checkGithubConnection(scope, stored.configuration, {})
      return {
        ok: status.ok,
        configured: status.configured,
        owner: status.owner,
        repo: status.repo,
        ...(status.labels === undefined ? {} : { labels: status.labels }),
        ...(status.reason === undefined ? {} : { reason: status.reason }),
        ...(status.code === undefined ? {} : { code: status.code }),
        ...(status.status === undefined ? {} : { status: status.status })
      }
    })),
  AutomationCredentialPut: ({ scope, credentialId, secret, expectedVersion }) =>
    guard(Effect.gen(function*() {
      const credentials = yield* CredentialRepository
      const bytes = new TextEncoder().encode(secret)
      const version = yield* credentials.putCredential(scope, credentialId, bytes, expectedVersion ?? 0).pipe(
        Effect.mapError(toRpcError)
      )
      yield* emit(AutomationCredentialChanged.make({
        projectId: scope.projectId,
        ownerId: scope.ownerId,
        credentialId,
        version,
        occurredAt: yield* nowIso
      }))
      return { credentialId, version, configured: true as const }
    })),
  AutomationCredentialRemove: ({ scope, credentialId, expectedVersion }) =>
    guard(Effect.gen(function*() {
      const credentials = yield* CredentialRepository
      yield* credentials.removeCredential(scope, credentialId, expectedVersion).pipe(Effect.mapError(toRpcError))
      yield* emit(AutomationCredentialChanged.make({
        projectId: scope.projectId,
        ownerId: scope.ownerId,
        credentialId,
        version: expectedVersion,
        occurredAt: yield* nowIso
      }))
      return { removed: true as const }
    })),
  AutomationCredentialList: ({ scope }) =>
    guard(Effect.gen(function*() {
      const credentials = yield* CredentialRepository
      const statuses = yield* credentials.listStatuses(scope).pipe(Effect.mapError(toRpcError))
      return { credentials: [...statuses] }
    })),
  AutomationPreviewClassification: ({ scope, routineId, inline, issue, decision }) =>
    guard(Effect.gen(function*() {
      const routines = yield* RoutineService
      const registry = yield* AutomationRegistryService
      const configuration = routineId !== undefined
        ? yield* routines.get(scope, routineId).pipe(
          Effect.mapError(toRpcError),
          Effect.flatMap((routine) =>
            routine === null
              ? Effect.fail(new AutomationNotFound({ code: "missing", message: "Routine does not exist" }))
              : Effect.succeed(routine.configuration)
          )
        )
        : inline !== undefined
          ? yield* decodeJson(RoutineConfiguration, {
            schemaVersion: 1 as const,
            kind: "routine-configuration" as const,
            reference: { routineId: inline.routineId, revision: 1 as const },
            scope,
            configuration: inline.configuration,
            integrations: [...inline.integrations],
            process: inline.process,
            ...(inline.template === undefined ? {} : { template: inline.template })
          }).pipe(
            Effect.mapError(toRpcError),
            Effect.flatMap((value) => registry.validateConfiguration(value).pipe(Effect.mapError(toRpcError)))
          )
          : yield* new AutomationInvalid({ code: "invalid-reference", message: "Preview needs a routineId or an inline process" })
      const outcome = yield* runIssueClassification({
        configuration,
        issue: {
          issueNumber: issue.issueNumber,
          title: issue.title,
          ...(issue.body === undefined ? {} : { body: issue.body })
        },
        mode: "preview",
        decide: () => Effect.succeed(decision),
        registry
      }).pipe(Effect.mapError(toRpcError))
      switch (outcome.kind) {
      case "classified":
        return {
          kind: "classified" as const,
          request: outcome.request,
          decision: outcome.decision,
          latencyMs: outcome.latencyMs,
          outcomeId: outcome.outcomeId,
          label: outcome.label,
          actions: outcome.actions.map((action) => ({ stepId: action.stepId, arguments: action.arguments })),
          executed: false as const
        }
      case "unresolved":
        return {
          kind: "unresolved" as const,
          request: outcome.request,
          decision: outcome.decision,
          latencyMs: outcome.latencyMs,
          reason: outcome.reason,
          executed: false as const
        }
      default:
        return {
          kind: "failed" as const,
          request: outcome.request,
          error: outcome.error,
          latencyMs: outcome.latencyMs,
          executed: false as const
        }
      }
    })),
  AutomationRunList: ({ scope, limit, cursor, routineId, mode, state }) =>
    guard(Effect.gen(function*() {
      const executions = yield* ExecutionRepository
      const page = yield* executions.listRuns(scope, {
        limit,
        ...(cursor === undefined ? {} : { cursor }),
        ...(routineId === undefined ? {} : { routineId }),
        ...(mode === undefined ? {} : { mode }),
        ...(state === undefined ? {} : { state })
      }).pipe(Effect.mapError(toRpcError))
      return {
        runs: page.items.map((item) => ({ run: item.value, version: item.version, sequence: item.sequence })),
        cursor: page.cursor
      }
    })),
  AutomationRunGet: ({ scope, runId }) =>
    guard(Effect.gen(function*() {
      const executions = yield* ExecutionRepository
      const history = yield* executions.history(scope, runId).pipe(Effect.mapError(toRpcError))
      if (history === null) return yield* new AutomationNotFound({ code: "missing", message: "Run does not exist" })
      return {
        run: { run: history.run.value, version: history.run.version, sequence: history.run.sequence },
        job: { job: history.job.value, version: history.job.version, sequence: history.job.sequence },
        attempts: [...history.attempts]
      }
    })),
  AutomationRunMetrics: ({ scope, routineId, mode }) =>
    guard(Effect.gen(function*() {
      const executions = yield* ExecutionRepository
      const counts: Record<"total" | "queued" | "running" | "succeeded" | "unresolved" | "failed" | "cancelled", number> = { total: 0, queued: 0, running: 0, succeeded: 0, unresolved: 0, failed: 0, cancelled: 0 }
      let cursor: string | undefined = undefined
      for (;;) {
        const page: { readonly items: ReadonlyArray<{ readonly value: { readonly state: { readonly kind: "queued" | "running" | "succeeded" | "unresolved" | "failed" | "cancelled" } } }>; readonly cursor: string | null } = yield* executions.listRuns(scope, {
          limit: 100,
          ...(cursor === undefined ? {} : { cursor }),
          ...(routineId === undefined ? {} : { routineId }),
          ...(mode === undefined ? {} : { mode })
        }).pipe(Effect.mapError(toRpcError))
        for (const item of page.items) {
          counts.total += 1
          counts[item.value.state.kind] += 1
        }
        if (page.cursor === null) return { ...counts }
        cursor = page.cursor
      }
    })),
  AutomationCatalog: () =>
    Effect.map(AutomationRegistryService, (registry) => registry.catalog())
} satisfies Pick<
  Handlers,
  | "AutomationRoutineCreate" | "AutomationRoutineEdit" | "AutomationRoutineEnable" | "AutomationRoutinePause"
  | "AutomationRoutineDelete" | "AutomationRoutineGet" | "AutomationRoutineList"
  | "AutomationIntegrationPut" | "AutomationIntegrationGet" | "AutomationIntegrationStatus"
  | "AutomationCredentialPut" | "AutomationCredentialRemove" | "AutomationCredentialList"
  | "AutomationPreviewClassification"
  | "AutomationRunList" | "AutomationRunGet" | "AutomationRunMetrics"
  | "AutomationCatalog"
>

type RpcError = AutomationInvalid | AutomationConflict | AutomationNotFound | AutomationStorageFailed

const toRpcError = (error: AutomationError | StorageError): RpcError => {
  if (error instanceof StorageError) {
    switch (error.code) {
    case "conflict":
      return new AutomationConflict({ code: error.code, message: error.message })
    case "missing":
      return new AutomationNotFound({ code: error.code, message: error.message })
    case "storage":
      return new AutomationStorageFailed({ code: error.code, message: error.message })
    default:
      return new AutomationInvalid({ code: error.code, message: error.message })
    }
  }
  switch (error.code) {
  case "duplicate-definition":
    return new AutomationConflict({ code: error.code, message: error.message })
  case "missing-definition":
    return new AutomationNotFound({ code: error.code, message: error.message })
  default:
    return new AutomationInvalid({ code: error.code, message: error.message })
  }
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso)

const emit = (event: AutomationEvent) => emitAutomationEvent(event)

const emitRoutine = Effect.fn("AutomationRpc.emitRoutine")(function*(
  scope: PersonalScope,
  routineId: string,
  revision: number,
  status: "enabled" | "paused" | "deleted"
) {
  yield* emit(AutomationRoutineChanged.make({
    projectId: scope.projectId,
    ownerId: scope.ownerId,
    routineId,
    revision,
    status,
    occurredAt: yield* nowIso
  }))
})

type Handlers = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof ExpandRpcs>>
