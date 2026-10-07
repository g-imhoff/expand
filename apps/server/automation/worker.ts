import { Cause, Clock, Effect, Layer, Schema } from "effect"
import { HttpClient } from "effect/http"
import { SqlClient } from "effect/sql/SqlClient"
import {
  AutomationError,
  decodeJson,
  LocalId,
  PersonalScope,
  sameDefinition
} from "@expand/contracts/automation"
import type {
  AutomationRun,
  InvocationAuthority,
  JevDecisionResult,
  RoutineConfiguration
} from "@expand/contracts/automation"
import {
  GithubIssuePayload,
  githubLabelActionReference,
  validateClassificationInput
} from "@expand/contracts/automation/github"
import { ConfigurationRepository } from "./configuration-repository.js"
import { CredentialRepository } from "./credential-repository.js"
import { ExecutionRepository } from "./execution-repository.js"
import type { Page, Query, RecordVersion } from "./execution-repository.js"
import { RoutineService } from "./routine-service.js"
import { AutomationRegistry } from "./registry.js"
import { buildClassificationRequest } from "./issue-classification.js"
import type { ClassificationDecideInput } from "./issue-classification.js"
import { emitNotificationForRun } from "./notification-emit.js"
import type { NotificationRepository } from "./notification-repository.js"
import { readGithubIssue } from "./github-connector.js"
import type { GithubConnectorOptions } from "./github-connector.js"
import { StorageError } from "./persistence-models.js"
import type { Attempt, Delivery, Job } from "./persistence-models.js"

export interface AutomationWorkerOptions {
  readonly pollIntervalMs: number
  readonly maxConcurrency: number
  readonly maxAttempts: number
  readonly attemptTimeoutMs: number
  readonly baseBackoffMs: number
}

export interface AutomationWorkerServices {
  readonly configurations: ConfigurationRepository["Service"]
  readonly credentials: CredentialRepository["Service"]
  readonly executions: ExecutionRepository["Service"]
  readonly sql: SqlClient
  readonly http: HttpClient.HttpClient
}

export interface AutomationWorkerEnvironment {
  readonly services: AutomationWorkerServices
  readonly registry: AutomationRegistry
  readonly routines: RoutineService["Service"]
  readonly decide: WorkerDecide
  readonly githubOptions?: GithubConnectorOptions
  readonly notifications?: NotificationRepository["Service"]
}

export type WorkerDecide = (
  input: ClassificationDecideInput
) => Effect.Effect<typeof JevDecisionResult.Type, unknown, HttpClient.HttpClient>

export type WorkerOutcomeKind = "completed" | "unresolved" | "failed" | "cancelled" | "skipped"

export const DefaultAutomationWorkerOptions: AutomationWorkerOptions = {
  pollIntervalMs: 250,
  maxConcurrency: 4,
  maxAttempts: 3,
  attemptTimeoutMs: 10000,
  baseBackoffMs: 100
}


export const listPendingScopes = (
  sql: SqlClient
): Effect.Effect<ReadonlyArray<PersonalScope>, StorageError> =>
  Effect.gen(function*() {
    const rows = yield* sql<{ owner_id: string; project_id: string }>`
      SELECT DISTINCT owner_id, project_id FROM automation_runs WHERE state IN ('queued', 'running')
    `.pipe(
      Effect.mapError(() => new StorageError({ code: "storage", message: "Scope discovery failed" }))
    )
    const scopes: Array<PersonalScope> = []
    for (const row of rows) {
      const scope = yield* decodeJson(PersonalScope, { ownerId: row.owner_id, projectId: row.project_id }).pipe(
        Effect.mapError(() => new StorageError({ code: "invalid", message: "Stored scope is not usable" }))
      )
      scopes.push(scope)
    }
    return scopes as ReadonlyArray<PersonalScope>
  })

export const reclaimInterruptedRuns = (
  environment: AutomationWorkerEnvironment,
  options: AutomationWorkerOptions = DefaultAutomationWorkerOptions
): Effect.Effect<number, StorageError> =>
  Effect.gen(function*() {
    void options
    const scopes = yield* listPendingScopes(environment.services.sql)
    let reclaimed = 0
    for (const scope of scopes) {
      let cursor: string | undefined = undefined
      while (true) {
        const query: Query = cursor === undefined
          ? { limit: 100, state: "running" }
          : { limit: 100, state: "running", cursor }
        const page: Page<RecordVersion<AutomationRun>> = yield* environment.services.executions.listRuns(scope, query)
        for (const record of page.items) {
          const current = yield* environment.services.executions.getRun(scope, record.value.id)
          if (current === null) continue
          if (current.value.state.kind !== "running") continue
          const jobExit = yield* Effect.exit(jobForRun(environment, scope, current.value))
          if (jobExit._tag === "Failure") continue
          const job = jobExit.value
          const jobRecord = yield* environment.services.executions.getJob(scope, job.id)
          if (jobRecord === null) continue
          const nextRun: AutomationRun = { ...current.value, state: { kind: "queued" } }
          const nextJob: Job = { ...job, state: nextRun.state }
          const updated = yield* Effect.exit(
            environment.services.executions.update(scope, {
              expectedRunVersion: current.version,
              expectedJobVersion: jobRecord.version,
              run: nextRun,
              job: nextJob
            })
          )
          if (updated._tag === "Success") {
            reclaimed += 1
            yield* Effect.logInfo("automation worker reclaimed interrupted run", { runId: current.value.id })
          }
        }
        if (page.cursor === null) break
        cursor = page.cursor
      }
    }
    return reclaimed
  })

export const sweepOnce = (
  environment: AutomationWorkerEnvironment,
  options: AutomationWorkerOptions = DefaultAutomationWorkerOptions
): Effect.Effect<number, StorageError, HttpClient.HttpClient> =>
  Effect.gen(function*() {
    const scopes = yield* listPendingScopes(environment.services.sql)
    let processed = 0
    for (const scope of scopes) {
      const page = yield* environment.services.executions.listRuns(scope, { limit: 20, state: "queued" })
      yield* Effect.forEach(
        page.items,
        (record) =>
          processRun(environment, options, scope, record.value.id).pipe(
            Effect.catch((error) =>
              Effect.logWarning("automation worker run failed", { runId: record.value.id, error: String(error) }).pipe(
                Effect.as("failed" as WorkerOutcomeKind)
              )
            )
          ),
        { concurrency: options.maxConcurrency }
      )
      processed += page.items.length
    }
    return processed
  })

export const startAutomationWorker = (
  environment: AutomationWorkerEnvironment,
  options: AutomationWorkerOptions = DefaultAutomationWorkerOptions
): Effect.Effect<void, never, HttpClient.HttpClient> =>
  Effect.gen(function*() {
    yield* reclaimInterruptedRuns(environment, options).pipe(
      Effect.catch(() => Effect.succeed(0))
    )
    while (true) {
      yield* sweepOnce(environment, options).pipe(Effect.catch(() => Effect.succeed(0)))
      yield* Effect.sleep(`${options.pollIntervalMs} millis`)
    }
  })

export const processRun = (
  environment: AutomationWorkerEnvironment,
  options: AutomationWorkerOptions,
  scope: PersonalScope,
  runId: string
): Effect.Effect<WorkerOutcomeKind, StorageError | AutomationError, HttpClient.HttpClient> =>
  Effect.gen(function*() {
    const exit = yield* Effect.exit(processRunInner(environment, options, scope, runId))
    yield* emitNotificationForRun(
      {
        executions: environment.services.executions,
        configurations: environment.services.configurations,
        ...(environment.notifications === undefined ? {} : { notifications: environment.notifications })
      },
      scope,
      runId
    ).pipe(Effect.ignore)
    return yield* exit
  })

const processRunInner = (
  environment: AutomationWorkerEnvironment,
  options: AutomationWorkerOptions,
  scope: PersonalScope,
  runId: string
): Effect.Effect<WorkerOutcomeKind, StorageError | AutomationError, HttpClient.HttpClient> =>
  Effect.gen(function*() {
    const runRecord = yield* environment.services.executions.getRun(scope, runId)
    if (runRecord === null) return "skipped" as WorkerOutcomeKind
    const run = runRecord.value
    if (run.state.kind !== "queued" && run.state.kind !== "running") return mapState(run.state.kind)
    if (run.mode !== "live") return "skipped" as WorkerOutcomeKind
    const dueCheck = yield* Effect.exit(environment.routines.assertDue(scope, run.configuration.routineId))
    if (dueCheck._tag === "Failure") {
      yield* cancelRun(environment, scope, run, runRecord.version, "Routine is not enabled for execution")
      return "cancelled" as WorkerOutcomeKind
    }
    const revision = yield* environment.services.configurations.getRevision(
      scope,
      run.configuration.routineId,
      run.configuration.revision
    )
    if (revision === null) {
      yield* failRun(environment, scope, run, runRecord.version, { code: "missing", message: "Routine revision is missing" })
      return "failed" as WorkerOutcomeKind
    }
    const authorityCheck = yield* Effect.exit(checkAuthorityGrants(run, revision, environment.registry))
    if (authorityCheck._tag === "Failure") {
      yield* failRun(environment, scope, run, runRecord.version, { code: "denied", message: "Authority does not grant this exact action version, integration and capabilities" })
      return "failed" as WorkerOutcomeKind
    }
    const deliveryRecord = yield* environment.services.executions.getDelivery(scope, run.input.id)
    if (deliveryRecord === null) {
      yield* failRun(environment, scope, run, runRecord.version, { code: "missing", message: "Delivery is missing" })
      return "failed" as WorkerOutcomeKind
    }
    const classification = yield* Effect.option(
      validateClassificationInput({
        configuration: revision.configuration,
        integrations: revision.integrations,
        process: revision.process
      })
    )
    if (classification._tag === "Some") {
      return yield* processClassificationRun(environment, options, scope, run, runRecord.version, revision, deliveryRecord.value)
    }
    return yield* processGenericRun(environment, options, scope, run, runRecord.version, revision, deliveryRecord.value)
  })

let attemptSequence = 0

const uniqueAttemptId = (base: string): string => {
  attemptSequence += 1
  return `${base}:${attemptSequence}`
}

const jobForRun = (
  environment: AutomationWorkerEnvironment,
  scope: PersonalScope,
  run: AutomationRun
): Effect.Effect<Job, StorageError> =>
  Effect.gen(function*() {
    const history = yield* environment.services.executions.history(scope, run.id)
    if (history !== null) return history.job.value
    const page = yield* environment.services.executions.listJobs(scope, { limit: 100 })
    for (const item of page.items) {
      if (item.value.runId === run.id) return item.value
    }
    return yield* new StorageError({ code: "missing", message: "Job is missing for run" })
  })

const mapState = (kind: string): WorkerOutcomeKind => {
  if (kind === "succeeded") return "completed"
  if (kind === "unresolved") return "unresolved"
  if (kind === "failed") return "failed"
  if (kind === "cancelled") return "cancelled"
  return "skipped"
}

const requiredCapabilities = (
  registry: AutomationRegistry,
  action: { readonly id: string; readonly version: number }
): ReadonlyArray<string> => {
  for (const definition of registry.catalog().definitions) {
    if (definition.kind === "action" && sameDefinition(definition.definition, action)) {
      return definition.capabilities
    }
  }
  return []
}

const isGranted = (
  authority: InvocationAuthority,
  registry: AutomationRegistry,
  action: { readonly id: string; readonly version: number },
  integrationId: string
): boolean => {
  if (!authority.integrationIds.includes(integrationId)) return false
  const grant = authority.actionGrants.find(
    (candidate) => sameDefinition(candidate.action, action) && candidate.integrationId === integrationId
  )
  if (grant === undefined) return false
  return requiredCapabilities(registry, action).every((capability) => grant.capabilities.includes(capability))
}

const checkAuthorityGrants = (
  run: AutomationRun,
  revision: RoutineConfiguration,
  registry: AutomationRegistry
): Effect.Effect<void, AutomationError> =>
  Effect.gen(function*() {
    const authority: InvocationAuthority = run.authority
    if (authority.scope.ownerId !== run.scope.ownerId || authority.scope.projectId !== run.scope.projectId) {
      return yield* new AutomationError({ code: "denied", message: "Authority does not match the personal scope and configuration revision" })
    }
    if (authority.configuration.routineId !== run.configuration.routineId || authority.configuration.revision !== run.configuration.revision) {
      return yield* new AutomationError({ code: "denied", message: "Authority does not match the personal scope and configuration revision" })
    }
    const steps = Object.values(revision.process.actions).flat()
    for (const step of steps) {
      if (!isGranted(authority, registry, step.action, step.integration.id)) {
        return yield* new AutomationError({ code: "denied", message: "Authority does not grant this exact action version, integration and capabilities" })
      }
    }
  })

const cancelRun = (
  environment: AutomationWorkerEnvironment,
  scope: PersonalScope,
  run: AutomationRun,
  expectedRunVersion: number,
  reason: string
): Effect.Effect<void, StorageError> =>
  Effect.gen(function*() {
    const job = yield* jobForRun(environment, scope, run)
    const jobRecord = yield* environment.services.executions.getJob(scope, job.id)
    if (jobRecord === null) return
    const nextRun: AutomationRun = { ...run, state: { kind: "cancelled", reason } }
    const nextJob: Job = { ...job, state: nextRun.state }
    yield* Effect.exit(
      environment.services.executions.update(scope, {
        expectedRunVersion,
        expectedJobVersion: jobRecord.version,
        run: nextRun,
        job: nextJob
      })
    )
  })

const failRun = (
  environment: AutomationWorkerEnvironment,
  scope: PersonalScope,
  run: AutomationRun,
  expectedRunVersion: number,
  error: { readonly code: string; readonly message: string }
): Effect.Effect<void, StorageError> =>
  Effect.gen(function*() {
    const job = yield* jobForRun(environment, scope, run)
    const jobRecord = yield* environment.services.executions.getJob(scope, job.id)
    if (jobRecord === null) return
    const failure = { code: error.code, message: error.message }
    const nextRun: AutomationRun = { ...run, state: { kind: "failed", error: failure } }
    const nextJob: Job = { ...job, state: nextRun.state }
    const history = yield* environment.services.executions.history(scope, run.id)
    const attemptNumber = history === null ? 1 : history.attempts.filter((entry) => entry.kind === "job").length + 1
    const startedAt = String(yield* Clock.currentTimeMillis)
    const finishedAt = String(yield* Clock.currentTimeMillis)
    const started: Attempt = {
      id: uniqueAttemptId(`${run.id}:job:fail:${attemptNumber}:${startedAt}`),
      scope,
      runId: run.id,
      jobId: job.id,
      stepId: "job",
      attempt: attemptNumber,
      startedAt,
      kind: "job",
      status: "started",
      request: { reason: "fail" }
    }
    yield* Effect.exit(environment.services.executions.recordAttempt(scope, started))
    const completed: Attempt = {
      ...(started as Extract<Attempt, { kind: "job"; status: "started" }>),
      status: "completed",
      completion: { finishedAt, error: failure }
    } as Attempt
    const recorded = yield* Effect.exit(
      environment.services.executions.recordAttempt(scope, completed, {
        expectedRunVersion,
        expectedJobVersion: jobRecord.version,
        run: nextRun,
        job: nextJob
      })
    )
    if (recorded._tag === "Failure") {
      yield* Effect.exit(
        environment.services.executions.update(scope, {
          expectedRunVersion,
          expectedJobVersion: jobRecord.version,
          run: nextRun,
          job: nextJob
        })
      )
    }
  })

const processClassificationRun = (
  environment: AutomationWorkerEnvironment,
  options: AutomationWorkerOptions,
  scope: PersonalScope,
  run: AutomationRun,
  runVersion: number,
  revision: RoutineConfiguration,
  delivery: Delivery
): Effect.Effect<WorkerOutcomeKind, StorageError | AutomationError, HttpClient.HttpClient> =>
  Effect.gen(function*() {
    const payload = yield* decodeJson(GithubIssuePayload, delivery.payload).pipe(
      Effect.mapError(() => new StorageError({ code: "invalid", message: "Delivery payload is not usable" }))
    )
    const built = yield* buildClassificationRequest({
      configuration: revision,
      issue: {
        issueNumber: payload.issueNumber,
        title: payload.title,
        ...(payload.body === undefined ? {} : { body: payload.body })
      },
      inputId: delivery.id
    }).pipe(
      Effect.mapError(
        (error) =>
          error instanceof StorageError
            ? error
            : new StorageError({ code: "invalid", message: "Invalid classification input" })
      )
    )
    const decision = run.decision === undefined
      ? yield* runDecisionWithRetries(environment, options, scope, run, runVersion, built.request, built.descriptions)
      : { outcome: "decided" as const, run, runVersion, decision: run.decision }
    if (decision.outcome === "failed") return "failed" as WorkerOutcomeKind
    if (decision.outcome === "cancelled") return "cancelled" as WorkerOutcomeKind
    if (decision.decision.kind === "abstained") {
      yield* recordUnresolved(environment, scope, decision.run, decision.runVersion, decision.decision)
      return "unresolved" as WorkerOutcomeKind
    }
    const resolved = yield* environment.registry.resolveSelectedActions(revision, built.triggerPayload, decision.decision).pipe(
      Effect.mapError((error) => new StorageError({ code: "invalid", message: error.message }))
    )
    if (resolved.selection.kind !== "selected") {
      const reason = resolved.selection.kind === "unresolved" ? resolved.selection.reason : "Decision did not select a route"
      yield* recordUnresolved(environment, scope, decision.run, decision.runVersion, {
        schemaVersion: 1 as const,
        kind: "abstained" as const,
        reason
      })
      return "unresolved" as WorkerOutcomeKind
    }
    return yield* runActionsToCompletion(
      environment,
      options,
      scope,
      decision.run,
      decision.runVersion,
      revision,
      built.triggerPayload as Schema.Json,
      decision.decision,
      resolved.actions
    )
  })

const processGenericRun = (
  environment: AutomationWorkerEnvironment,
  options: AutomationWorkerOptions,
  scope: PersonalScope,
  run: AutomationRun,
  runVersion: number,
  revision: RoutineConfiguration,
  delivery: Delivery
): Effect.Effect<WorkerOutcomeKind, StorageError | AutomationError, HttpClient.HttpClient> =>
  Effect.gen(function*() {
    const triggerPayload = yield* decodeJson(Schema.Json, delivery.payload).pipe(
      Effect.mapError(() => new StorageError({ code: "invalid", message: "Delivery payload is not usable" }))
    )
    let currentRun = run
    let currentVersion = runVersion
    let decision: typeof JevDecisionResult.Type | undefined = run.decision
    if (revision.process.decision !== undefined && decision === undefined) {
      const outcomes = [...revision.process.decision.outcomes]
      const request = yield* decodeJson(
        Schema.Struct({
          schemaVersion: Schema.Literal(1),
          kind: Schema.Literal("jev-request"),
          provider: Schema.Literal("opencode-zen"),
          model: Schema.Literal("jev"),
          version: Schema.Literal("1.13"),
          configuration: Schema.Struct({ routineId: LocalId, revision: Schema.Int }),
          input: Schema.Struct({ kind: Schema.Literal("input-reference"), id: LocalId }),
          outcomes: Schema.Array(LocalId),
          data: Schema.Json
        }),
        {
          schemaVersion: 1,
          kind: "jev-request",
          provider: "opencode-zen",
          model: "jev",
          version: "1.13",
          configuration: { routineId: run.configuration.routineId, revision: run.configuration.revision },
          input: { kind: "input-reference", id: run.input.id },
          outcomes,
          data: triggerPayload
        }
      ).pipe(Effect.mapError(() => new StorageError({ code: "invalid", message: "Decision request is not usable" })))
      const descriptions: Record<string, string> = {}
      for (const outcome of outcomes) descriptions[outcome] = outcome
      const decided = yield* runDecisionWithRetries(
        environment,
        options,
        scope,
        currentRun,
        currentVersion,
        request as ClassificationDecideInput["request"],
        descriptions
      )
      if (decided.outcome === "failed") return "failed" as WorkerOutcomeKind
      if (decided.outcome === "cancelled") return "cancelled" as WorkerOutcomeKind
      currentRun = decided.run
      currentVersion = decided.runVersion
      decision = decided.decision
      if (decision.kind === "abstained") {
        yield* recordUnresolved(environment, scope, currentRun, currentVersion, decision)
        return "unresolved" as WorkerOutcomeKind
      }
    }
    const resolved = yield* environment.registry.resolveSelectedActions(revision, triggerPayload, decision).pipe(
      Effect.mapError((error) => new StorageError({ code: "invalid", message: error.message }))
    )
    if (resolved.selection.kind !== "selected") {
      const reason = resolved.selection.reason
      if (decision === undefined) {
        const abstained = { schemaVersion: 1 as const, kind: "abstained" as const, reason }
        const nextRun: AutomationRun = { ...currentRun, state: { kind: "unresolved", reason }, decision: abstained, actions: [] }
        yield* updateRunState(environment, scope, currentRun, currentVersion, nextRun)
        return "unresolved" as WorkerOutcomeKind
      }
      const abstained = decision.kind === "abstained" ? decision : { schemaVersion: 1 as const, kind: "abstained" as const, reason }
      yield* recordUnresolved(environment, scope, currentRun, currentVersion, abstained)
      return "unresolved" as WorkerOutcomeKind
    }
    return yield* runActionsToCompletion(environment, options, scope, currentRun, currentVersion, revision, triggerPayload, decision, resolved.actions)
  })

interface Decided {
  readonly outcome: "decided"
  readonly run: AutomationRun
  readonly runVersion: number
  readonly decision: typeof JevDecisionResult.Type
}

interface DecisionFailed {
  readonly outcome: "failed"
}

interface DecisionCancelled {
  readonly outcome: "cancelled"
}

const runDecisionWithRetries = (
  environment: AutomationWorkerEnvironment,
  options: AutomationWorkerOptions,
  scope: PersonalScope,
  run: AutomationRun,
  runVersion: number,
  request: ClassificationDecideInput["request"],
  descriptions: Record<string, string>
): Effect.Effect<Decided | DecisionFailed | DecisionCancelled, StorageError | AutomationError, HttpClient.HttpClient> =>
  Effect.gen(function*() {
    const job = yield* jobForRun(environment, scope, run)
    let currentRun = run
    let currentVersion = runVersion
    for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
      const paused = yield* Effect.exit(environment.routines.assertDue(scope, currentRun.configuration.routineId))
      if (paused._tag === "Failure") {
        yield* cancelRun(environment, scope, currentRun, currentVersion, "Routine is not enabled for execution")
        return { outcome: "cancelled" } as DecisionCancelled
      }
      const history = yield* environment.services.executions.history(scope, currentRun.id)
      const attemptNumber = history === null ? attempt : history.attempts.filter((entry) => entry.kind === "decision").length + 1
      const startedAt = String(yield* Clock.currentTimeMillis)
      const attemptId = uniqueAttemptId(`${currentRun.id}:decision:${attemptNumber}:${startedAt}`)
      const started: Attempt = {
        id: attemptId,
        scope,
        runId: currentRun.id,
        jobId: job.id,
        stepId: "decision",
        attempt: attemptNumber,
        startedAt,
        kind: "decision",
        status: "started",
        request: request as never
      }
      yield* Effect.exit(environment.services.executions.recordAttempt(scope, started))
      const finishedAt = String(yield* Clock.currentTimeMillis)
      const result = yield* Effect.exit(
        environment.decide({ request, descriptions }).pipe(Effect.timeout(`${options.attemptTimeoutMs} millis`))
      )
      if (result._tag === "Success") {
        const value = result.value
        if (value.kind !== "selected" && value.kind !== "abstained") {
          const completed: Attempt = {
            ...(started as Extract<Attempt, { kind: "decision"; status: "started" }>),
            status: "completed",
            finishedAt,
            error: { code: "invalid-contract", message: "Decision is not usable" }
          } as Attempt
          yield* Effect.exit(environment.services.executions.recordAttempt(scope, completed))
        } else {
          const completed: Attempt = {
            ...(started as Extract<Attempt, { kind: "decision"; status: "started" }>),
            status: "completed",
            finishedAt,
            result: value
          } as Attempt
          const nextRun: AutomationRun = { ...currentRun, state: { kind: "running" }, decision: value, actions: currentRun.actions }
          const jobRecord = yield* environment.services.executions.getJob(scope, job.id)
          if (jobRecord !== null) {
            const recordExit = yield* Effect.exit(
              environment.services.executions.recordAttempt(scope, completed, {
                expectedRunVersion: currentVersion,
                expectedJobVersion: jobRecord.version,
                run: nextRun,
                job: { ...job, state: nextRun.state }
              })
            )
            if (recordExit._tag === "Success") {
              const refreshed = yield* environment.services.executions.getRun(scope, currentRun.id)
              if (refreshed !== null) {
                currentRun = refreshed.value
                currentVersion = refreshed.version
              } else {
                currentRun = nextRun
                currentVersion = currentVersion + 1
              }
              return { outcome: "decided", run: currentRun, runVersion: currentVersion, decision: value } as Decided
            }
            const refreshed = yield* environment.services.executions.getRun(scope, currentRun.id)
            if (refreshed !== null) {
              currentRun = refreshed.value
              currentVersion = refreshed.version
            }
            if (attempt < options.maxAttempts) yield* Effect.sleep(`${options.baseBackoffMs * 2 ** (attempt - 1)} millis`)
            continue
          }
        }
      } else {
        const completed: Attempt = {
          ...(started as Extract<Attempt, { kind: "decision"; status: "started" }>),
          status: "completed",
          finishedAt,
          error: { code: "transient", message: "Decision attempt failed" }
        } as Attempt
        yield* Effect.exit(environment.services.executions.recordAttempt(scope, completed))
      }
      if (attempt === options.maxAttempts) {
        yield* failRun(environment, scope, currentRun, currentVersion, { code: "transient", message: "Decision failed after bounded retries" })
        return { outcome: "failed" } as DecisionFailed
      }
      yield* Effect.sleep(`${options.baseBackoffMs * 2 ** (attempt - 1)} millis`)
    }
    yield* failRun(environment, scope, currentRun, currentVersion, { code: "transient", message: "Decision failed after bounded retries" })
    return { outcome: "failed" } as DecisionFailed
  })

const recordUnresolved = (
  environment: AutomationWorkerEnvironment,
  scope: PersonalScope,
  run: AutomationRun,
  runVersion: number,
  decision: typeof JevDecisionResult.Type
): Effect.Effect<void, StorageError> =>
  Effect.gen(function*() {
    const reason = decision.kind === "abstained" ? decision.reason : "Decision did not select a route"
    const nextRun: AutomationRun = { ...run, state: { kind: "unresolved", reason }, decision, actions: [] }
    yield* updateRunState(environment, scope, run, runVersion, nextRun)
  })

const updateRunState = (
  environment: AutomationWorkerEnvironment,
  scope: PersonalScope,
  run: AutomationRun,
  runVersion: number,
  nextRun: AutomationRun
): Effect.Effect<void, StorageError> =>
  Effect.gen(function*() {
    const job = yield* jobForRun(environment, scope, run)
    const jobRecord = yield* environment.services.executions.getJob(scope, job.id)
    if (jobRecord === null) return
    const nextJob: Job = { ...job, state: nextRun.state }
    yield* Effect.exit(
      environment.services.executions.update(scope, {
        expectedRunVersion: runVersion,
        expectedJobVersion: jobRecord.version,
        run: nextRun,
        job: nextJob
      })
    )
  })

const runActionsToCompletion = (
  environment: AutomationWorkerEnvironment,
  options: AutomationWorkerOptions,
  scope: PersonalScope,
  run: AutomationRun,
  runVersion: number,
  revision: RoutineConfiguration,
  triggerPayload: Schema.Json,
  decision: typeof JevDecisionResult.Type | undefined,
  steps: ReadonlyArray<{
    readonly stepId: string
    readonly action: { readonly id: string; readonly version: number }
    readonly integrationId: string
    readonly arguments: Schema.Json
  }>
): Effect.Effect<WorkerOutcomeKind, StorageError | AutomationError, HttpClient.HttpClient> =>
  Effect.gen(function*() {
    let currentRun = run
    let currentVersion = runVersion
    for (const step of steps) {
      if (currentRun.actions.some((outcome) => outcome.stepId === step.stepId && outcome.kind === "succeeded")) continue
      const dueAgain = yield* Effect.exit(environment.routines.assertDue(scope, currentRun.configuration.routineId))
      if (dueAgain._tag === "Failure") {
        yield* cancelRun(environment, scope, currentRun, currentVersion, "Routine is not enabled for execution")
        return "cancelled" as WorkerOutcomeKind
      }
      if (!isGranted(currentRun.authority, environment.registry, step.action, step.integrationId)) {
        yield* failRun(environment, scope, currentRun, currentVersion, {
          code: "denied",
          message: "Authority does not grant this exact action version, integration and capabilities"
        })
        return "failed" as WorkerOutcomeKind
      }
      const invoked = yield* invokeActionWithRetries(environment, options, scope, currentRun, currentVersion, revision, triggerPayload, decision, step)
      if (invoked.outcome !== "done") return invoked.outcome as WorkerOutcomeKind
      currentRun = invoked.run
      currentVersion = invoked.runVersion
    }
    yield* recordSucceeded(environment, scope, currentRun, currentVersion)
    return "completed" as WorkerOutcomeKind
  })

interface ActionDone {
  readonly outcome: "done"
  readonly run: AutomationRun
  readonly runVersion: number
}

interface ActionStopped {
  readonly outcome: "failed" | "cancelled"
}

const invokeActionWithRetries = (
  environment: AutomationWorkerEnvironment,
  options: AutomationWorkerOptions,
  scope: PersonalScope,
  run: AutomationRun,
  runVersion: number,
  revision: RoutineConfiguration,
  triggerPayload: Schema.Json,
  decision: typeof JevDecisionResult.Type | undefined,
  step: {
    readonly stepId: string
    readonly action: { readonly id: string; readonly version: number }
    readonly integrationId: string
    readonly arguments: Schema.Json
  }
): Effect.Effect<ActionDone | ActionStopped, StorageError | AutomationError, HttpClient.HttpClient> =>
  Effect.gen(function*() {
    const job = yield* jobForRun(environment, scope, run)
    const integration = revision.integrations.find((candidate) => candidate.id === step.integrationId)
    if (integration === undefined) {
      yield* failRun(environment, scope, run, runVersion, { code: "invalid-reference", message: "Integration instance is not configured" })
      return { outcome: "failed" } as ActionStopped
    }
    let currentRun = run
    let currentVersion = runVersion
    for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
      const paused = yield* Effect.exit(environment.routines.assertDue(scope, currentRun.configuration.routineId))
      if (paused._tag === "Failure") {
        yield* cancelRun(environment, scope, currentRun, currentVersion, "Routine is not enabled for execution")
        return { outcome: "cancelled" } as ActionStopped
      }
      if (!isGranted(currentRun.authority, environment.registry, step.action, step.integrationId)) {
        yield* failRun(environment, scope, currentRun, currentVersion, {
          code: "denied",
          message: "Authority does not grant this exact action version, integration and capabilities"
        })
        return { outcome: "failed" } as ActionStopped
      }
      const history = yield* environment.services.executions.history(scope, currentRun.id)
      const attemptNumber = history === null
        ? attempt
        : history.attempts.filter((entry) => entry.kind === "action" && entry.stepId === step.stepId).length + 1
      const startedAt = String(yield* Clock.currentTimeMillis)
      const attemptId = uniqueAttemptId(`${currentRun.id}:${step.stepId}:${attemptNumber}:${startedAt}`)
      const started: Attempt = {
        id: attemptId,
        scope,
        runId: currentRun.id,
        jobId: job.id,
        stepId: step.stepId,
        attempt: attemptNumber,
        startedAt,
        kind: "action",
        status: "started",
        integration: { id: integration.id, definition: integration.definition },
        action: { ...step.action },
        arguments: step.arguments
      }
      yield* environment.services.executions.recordAttempt(scope, started)
      const hasUnfinished = history !== null &&
        history.attempts.some((entry) => entry.kind === "action" && entry.stepId === step.stepId && entry.status === "started")
      let skipInvoke = false
      let reconciledResult: Schema.Json = null
      if (attempt > 1 || hasUnfinished) {
        const reconciledLabel = yield* reconcileUncertainWrite(environment, scope, revision, step).pipe(
          Effect.timeout(`${options.attemptTimeoutMs} millis`),
          Effect.orElseSucceed(() => null)
        )
        if (reconciledLabel !== null) {
          skipInvoke = true
          reconciledResult = { reconciled: true, label: reconciledLabel } as Schema.Json
        }
      }
      const finishedAt = String(yield* Clock.currentTimeMillis)
      const invoked = skipInvoke
        ? yield* Effect.exit(Effect.succeed(reconciledResult))
        : yield* Effect.exit(
          environment.registry.invokeAction(
            {
              configuration: revision,
              stepId: step.stepId,
              triggerPayload,
              ...(decision === undefined ? {} : { decision }),
              mode: "live"
            },
            currentRun.authority
          ).pipe(Effect.timeout(`${options.attemptTimeoutMs} millis`))
        )
      if (invoked._tag === "Success") {
        const outcome = {
          kind: "succeeded" as const,
          stepId: step.stepId,
          action: { ...step.action },
          result: invoked.value as Schema.Json
        }
        const completed: Attempt = {
          ...(started as Extract<Attempt, { kind: "action"; status: "started" }>),
          status: "completed",
          finishedAt,
          outcome
        } as Attempt
        const nextActions = [...currentRun.actions.filter((existing) => existing.stepId !== step.stepId), outcome]
        const nextRun: AutomationRun = { ...currentRun, state: { kind: "running" }, actions: nextActions }
        const currentJob = yield* jobForRun(environment, scope, currentRun)
        const currentJobRecord = yield* environment.services.executions.getJob(scope, currentJob.id)
        if (currentJobRecord !== null) {
          const recordExit = yield* Effect.exit(
            environment.services.executions.recordAttempt(scope, completed, {
              expectedRunVersion: currentVersion,
              expectedJobVersion: currentJobRecord.version,
              run: nextRun,
              job: { ...currentJob, state: nextRun.state }
            })
          )
          if (recordExit._tag === "Success") {
            const refreshed = yield* environment.services.executions.getRun(scope, currentRun.id)
            if (refreshed !== null) {
              return { outcome: "done", run: refreshed.value, runVersion: refreshed.version } as ActionDone
            }
            return { outcome: "done", run: nextRun, runVersion: currentVersion + 1 } as ActionDone
          }
          const refreshed = yield* environment.services.executions.getRun(scope, currentRun.id)
          if (refreshed !== null) {
            currentRun = refreshed.value
            currentVersion = refreshed.version
          }
          if (attempt === options.maxAttempts) {
            yield* failRun(environment, scope, currentRun, currentVersion, { code: "storage", message: "Action completion write failed" })
            return { outcome: "failed" } as ActionStopped
          }
          yield* Effect.sleep(`${options.baseBackoffMs * 2 ** (attempt - 1)} millis`)
          continue
        }
      }
      const failure = toActionFailure(invoked._tag === "Failure" ? invoked.cause : undefined)
      if (failure.code === "denied") {
        const outcome = { kind: "failed" as const, stepId: step.stepId, action: { ...step.action }, error: failure }
        const completed: Attempt = {
          ...(started as Extract<Attempt, { kind: "action"; status: "started" }>),
          status: "completed",
          finishedAt,
          outcome
        } as Attempt
        yield* Effect.exit(environment.services.executions.recordAttempt(scope, completed))
        yield* failRun(environment, scope, currentRun, currentVersion, failure)
        return { outcome: "failed" } as ActionStopped
      }
      const outcome = { kind: "failed" as const, stepId: step.stepId, action: { ...step.action }, error: failure }
      const completed: Attempt = {
        ...(started as Extract<Attempt, { kind: "action"; status: "started" }>),
        status: "completed",
        finishedAt,
        outcome
      } as Attempt
      yield* Effect.exit(environment.services.executions.recordAttempt(scope, completed))
      if (attempt === options.maxAttempts) {
        yield* failRun(environment, scope, currentRun, currentVersion, failure)
        return { outcome: "failed" } as ActionStopped
      }
      yield* Effect.sleep(`${options.baseBackoffMs * 2 ** (attempt - 1)} millis`)
    }
    yield* failRun(environment, scope, currentRun, currentVersion, { code: "transient", message: "Action failed after bounded retries" })
    return { outcome: "failed" } as ActionStopped
  })

const reconcileUncertainWrite = (
  environment: AutomationWorkerEnvironment,
  scope: PersonalScope,
  revision: RoutineConfiguration,
  step: {
    readonly stepId: string
    readonly action: { readonly id: string; readonly version: number }
    readonly integrationId: string
    readonly arguments: Schema.Json
  }
): Effect.Effect<string | null, never, HttpClient.HttpClient> =>
  Effect.gen(function*() {
    if (!sameDefinition(step.action, githubLabelActionReference)) return null
    const integration = revision.integrations.find((candidate) => candidate.id === step.integrationId)
    if (integration === undefined) return null
    const args = yield* decodeJson(Schema.Struct({ issueNumber: Schema.Int, label: Schema.String }), step.arguments).pipe(Effect.option)
    if (args._tag === "None") return null
    const servicesLayer = Layer.mergeAll(
      Layer.succeed(CredentialRepository, environment.services.credentials),
      Layer.succeed(HttpClient.HttpClient, environment.services.http)
    )
    const readExit = yield* Effect.exit(
      readGithubIssue(scope, integration, args.value.issueNumber, environment.githubOptions).pipe(Effect.provide(servicesLayer))
    )
    if (readExit._tag === "Success") {
      const issue = readExit.value
      yield* Effect.logInfo("automation worker reconciled uncertain write against current GitHub state", {
        issueNumber: args.value.issueNumber,
        label: args.value.label,
        labels: issue.labels.join(",")
      })
      return issue.labels.includes(args.value.label) ? args.value.label : null
    }
    return null
  })

const recordSucceeded = (
  environment: AutomationWorkerEnvironment,
  scope: PersonalScope,
  run: AutomationRun,
  runVersion: number
): Effect.Effect<void, StorageError> =>
  Effect.gen(function*() {
    const job = yield* jobForRun(environment, scope, run)
    const startedAt = String(yield* Clock.currentTimeMillis)
    const finishedAt = String(yield* Clock.currentTimeMillis)
    const history = yield* environment.services.executions.history(scope, run.id)
    const attemptNumber = history === null ? 1 : history.attempts.filter((entry) => entry.kind === "job").length + 1
    const started: Attempt = {
      id: uniqueAttemptId(`${run.id}:job:${attemptNumber}:${startedAt}`),
      scope,
      runId: run.id,
      jobId: job.id,
      stepId: "job",
      attempt: attemptNumber,
      startedAt,
      kind: "job",
      status: "started",
      request: { reason: "complete" }
    }
    yield* Effect.exit(environment.services.executions.recordAttempt(scope, started))
    const result = { completed: true, actions: run.actions.length }
    const completed: Attempt = {
      ...(started as Extract<Attempt, { kind: "job"; status: "started" }>),
      status: "completed",
      completion: { finishedAt, result }
    } as Attempt
    const nextRun: AutomationRun = { ...run, state: { kind: "succeeded", result } }
    const nextJob: Job = { ...job, state: nextRun.state }
    const jobRecord = yield* environment.services.executions.getJob(scope, job.id)
    if (jobRecord === null) return
    yield* Effect.exit(
      environment.services.executions.recordAttempt(scope, completed, {
        expectedRunVersion: runVersion,
        expectedJobVersion: jobRecord.version,
        run: nextRun,
        job: nextJob
      })
    )
  })

const toActionFailure = (cause: unknown): { readonly code: string; readonly message: string } => {
  if (cause !== undefined) {
    const squashed = Cause.squash(cause as never) as { code?: unknown; message?: unknown }
    if (typeof squashed === "object" && squashed !== null && typeof squashed.code === "string") {
      const message = typeof squashed.message === "string" ? squashed.message : "Action failed"
      return { code: squashed.code, message }
    }
  }
  return { code: "handler-failed", message: "Action failed" }
}
