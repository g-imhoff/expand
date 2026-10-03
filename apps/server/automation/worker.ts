import { Clock, Config, Context, DateTime, Duration, Effect, Layer, Option, Result, Schema } from "effect"
import { HttpClient } from "effect/http"
import {
  AutomationError,
  JevDecisionRequest,
  LocalId,
  PersonalScope,
  decodeJson,
  sameDefinition
} from "@expand/contracts/automation"
import type { ActionOutcome, AutomationFailure, AutomationRun, DefinitionReference, RoutineConfiguration } from "@expand/contracts/automation"
import { AutomationRunChanged } from "@expand/contracts/events/automation"
import { EventBus } from "@expand/server/application/event-bus"
import { AutomationEventStore } from "@expand/server/automation/event-store"
import { emitNotificationForRun } from "./notification-emit.js"
import { ConfigurationRepository } from "./configuration-repository.js"
import { CredentialRepository } from "./credential-repository.js"
import { ExecutionRepository } from "./execution-repository.js"
import type { DueRun } from "./execution-repository.js"
import { RoutineService } from "./routine-service.js"
import { AutomationRegistry } from "./registry.js"
import { JevDecisionError, classifyJev } from "./jev-client.js"
import type { JevClassifyOptions } from "./jev-client.js"
import type { Attempt, Job } from "./persistence-models.js"
import { StorageError } from "./persistence-models.js"

export interface WorkerJevOptions extends JevClassifyOptions {
  readonly apiKey?: string
}

export interface WorkerOptions {
  readonly concurrency: number
  readonly pollBatchSize: number
  readonly pollIntervalMs: number
  readonly attemptTimeoutMs: number
  readonly maxAttempts: number
  readonly baseBackoffMs: number
  readonly jev: WorkerJevOptions
}

export class AutomationWorker extends Context.Service<AutomationWorker, {
  readonly processRun: (scope: PersonalScope, runId: string) => Effect.Effect<void, StorageError, never>
  readonly runOnce: () => Effect.Effect<number, StorageError, never>
  readonly reclaim: () => Effect.Effect<number, StorageError, never>
  readonly runLoop: () => Effect.Effect<never, never, never>
}>()("expand/AutomationWorker") {}

export const defaultWorkerOptions: WorkerOptions = {
  concurrency: 4,
  pollBatchSize: 20,
  pollIntervalMs: 1000,
  attemptTimeoutMs: 10000,
  maxAttempts: 3,
  baseBackoffMs: 100,
  jev: {}
}

export const AutomationWorkerLayer = (
  registry: AutomationRegistry<ConfigurationRepository | CredentialRepository | HttpClient.HttpClient>,
  options?: Partial<WorkerOptions>
): Layer.Layer<AutomationWorker, never, ExecutionRepository | ConfigurationRepository | CredentialRepository | RoutineService | HttpClient.HttpClient> => {
  const settled: WorkerOptions = {
    ...defaultWorkerOptions,
    ...options,
    jev: { ...defaultWorkerOptions.jev, ...options?.jev }
  }
  return Layer.effect(
    AutomationWorker,
    Effect.gen(function*() {
      const executions = yield* ExecutionRepository
      const configurations = yield* ConfigurationRepository
      const credentials = yield* CredentialRepository
      const routines = yield* RoutineService
      const httpClient = yield* HttpClient.HttpClient
      const deps: WorkerDeps = { executions, configurations, credentials, httpClient, routines, registry, options: settled }
      return AutomationWorker.of({
        processRun: (scope, runId) => processSingleRunNotified(deps, scope, runId),
        runOnce: () => runBatch(deps, false),
        reclaim: () => runBatch(deps, true),
        runLoop: () => workerLoop(deps)
      })
    })
  )
}

export const resolveOutcomeDescriptions = (
  configuration: unknown,
  outcomes: ReadonlyArray<string>
): Record<string, string> => {
  if (configuration !== null && typeof configuration === "object" && !Array.isArray(configuration)) {
    const labels = (configuration as Record<string, unknown>)["labels"]
    if (labels !== null && typeof labels === "object" && !Array.isArray(labels)) {
      const record = labels as Record<string, unknown>
      if (outcomes.every((outcome) => typeof record[outcome] === "string" && (record[outcome] as string).length > 0)) {
        return Object.fromEntries(outcomes.map((outcome) => [outcome, record[outcome] as string]))
      }
    }
    const descriptions = (configuration as Record<string, unknown>)["descriptions"]
    if (descriptions !== null && typeof descriptions === "object" && !Array.isArray(descriptions)) {
      const record = descriptions as Record<string, unknown>
      if (outcomes.every((outcome) => typeof record[outcome] === "string" && (record[outcome] as string).length > 0)) {
        return Object.fromEntries(outcomes.map((outcome) => [outcome, record[outcome] as string]))
      }
    }
  }
  return Object.fromEntries(outcomes.map((outcome) => [outcome, outcome]))
}

export const isRetryableDecisionError = (error: unknown): boolean => {
  if (error instanceof JevDecisionError) {
    return error.code === "rate-limited" || error.code === "transient" || error.code === "timeout"
  }
  if (error instanceof AutomationError && error.code === "handler-failed" && error.failure !== undefined) {
    return isRetryableFailureCode(error.failure)
  }
  return false
}

export const isRetryableActionError = (error: unknown): boolean => {
  if (error instanceof AutomationError) {
    if (error.code === "handler-failed" && error.failure !== undefined) return isRetryableFailureCode(error.failure)
    return false
  }
  return false
}

export const toDecisionFailure = (error: JevDecisionError): AutomationFailure => ({
  code: error.code,
  message: error.message,
  ...(error.status === undefined ? {} : { details: { status: error.status } })
})

export const toActionFailure = (error: AutomationError, stepId: string): AutomationFailure => {
  if (error.code === "handler-failed" && error.failure !== undefined) return error.failure
  if (error.code === "denied") return { code: "denied", message: `Action ${stepId} is outside the run grants` }
  return { code: error.code, message: error.message }
}

interface WorkerDeps {
  readonly executions: ExecutionRepository["Service"]
  readonly configurations: ConfigurationRepository["Service"]
  readonly credentials: CredentialRepository["Service"]
  readonly httpClient: HttpClient.HttpClient
  readonly routines: RoutineService["Service"]
  readonly registry: AutomationRegistry<ConfigurationRepository | CredentialRepository | HttpClient.HttpClient>
  readonly options: WorkerOptions
}

const serviceLayerFor = (deps: WorkerDeps) =>
  Layer.mergeAll(
    Layer.succeed(ConfigurationRepository, deps.configurations),
    Layer.succeed(CredentialRepository, deps.credentials),
    Layer.succeed(HttpClient.HttpClient, deps.httpClient)
  )

const runBatch = Effect.fn("AutomationWorker.runBatch")(function*(deps: WorkerDeps, runningOnly: boolean) {
  const due = yield* deps.executions.scanDue(deps.options.pollBatchSize)
  const items = runningOnly ? due.filter((item) => item.state === "running") : due
  yield* Effect.all(items.map((item: DueRun) => processSingleRunNotified(deps, item.scope, item.runId).pipe(Effect.catch(() => Effect.void))), { concurrency: deps.options.concurrency })
  return items.length
})

const processSingleRunNotified = Effect.fn("AutomationWorker.processSingleRunNotified")(function*(
  deps: WorkerDeps,
  scope: PersonalScope,
  runId: string
) {
  yield* processSingleRun(deps, scope, runId)
  yield* Effect.result(notifyRunChanged(deps, scope, runId))
  yield* Effect.result(emitNotificationForRun(deps.executions, deps.configurations, scope, runId))
})

const notifyRunChanged = Effect.fn("AutomationWorker.notifyRunChanged")(function*(
  deps: WorkerDeps,
  scope: PersonalScope,
  runId: string
) {
  const store = yield* Effect.serviceOption(AutomationEventStore)
  const bus = yield* Effect.serviceOption(EventBus)
  if (Option.isNone(store) || Option.isNone(bus)) return
  const current = yield* deps.executions.getRun(scope, runId)
  if (current === null) return
  const event = AutomationRunChanged.make({
    projectId: scope.projectId,
    ownerId: scope.ownerId,
    runId,
    routineId: current.value.configuration.routineId,
    state: current.value.state.kind,
    occurredAt: yield* DateTime.now.pipe(Effect.map(DateTime.formatIso))
  })
  const seq = yield* store.value.append(event)
  yield* bus.value.publish({ seq, event })
})

const workerLoop = Effect.fn("AutomationWorker.runLoop")(function*(deps: WorkerDeps) {
  yield* runBatch(deps, true).pipe(Effect.catch(() => Effect.void))
  return yield* Effect.forever(
    runBatch(deps, false).pipe(
      Effect.catch(() => Effect.void),
      Effect.andThen(Effect.sleep(Duration.millis(deps.options.pollIntervalMs)))
    )
  )
})

const processSingleRun = Effect.fn("AutomationWorker.processSingleRun")(function*(deps: WorkerDeps, scope: PersonalScope, runId: string) {
  const history = yield* deps.executions.history(scope, runId)
  if (history === null) return
  if (history.run.value.state.kind !== "queued" && history.run.value.state.kind !== "running") return
  let run = history.run.value
  let job = history.job.value
  let runVersion = history.run.version
  let jobVersion = history.job.version
  let attempts: ReadonlyArray<Attempt> = history.attempts
  const due = yield* Effect.result(deps.routines.assertDue(scope, run.configuration.routineId))
  if (Result.isFailure(due)) {
    yield* cancelForPaused(deps, scope, run, job, attempts, runVersion, jobVersion)
    return
  }
  const revision = yield* deps.configurations.getRevision(scope, run.configuration.routineId, run.configuration.revision)
  if (revision === null) {
    yield* cancelForPaused(deps, scope, run, job, attempts, runVersion, jobVersion)
    return
  }
  const stored = yield* deps.executions.getDelivery(scope, run.input.id)
  if (stored === null) {
    yield* failForMissingDelivery(deps, scope, run, job, attempts, runVersion, jobVersion)
    return
  }
  const triggerPayload = stored.value.payload
  const ensured = yield* ensureJobStarted(deps, scope, run, job, attempts)
  attempts = ensured.attempts
  const jobStart = ensured.start
  if (revision.process.decision !== undefined && run.decision === undefined) {
    const progressed = yield* runDecisionPhase(deps, scope, revision, triggerPayload, run, job, attempts, runVersion, jobVersion)
    if (progressed.finished) return
    run = progressed.run
    job = progressed.job
    attempts = progressed.attempts
    runVersion = progressed.runVersion
    jobVersion = progressed.jobVersion
  }
  yield* runActionPhase(deps, scope, revision, triggerPayload, run, job, attempts, runVersion, jobVersion, jobStart)
})

interface Progress {
  readonly finished: boolean
  readonly run: AutomationRun
  readonly job: Job
  readonly attempts: ReadonlyArray<Attempt>
  readonly runVersion: number
  readonly jobVersion: number
}

const cancelForPaused = Effect.fn("AutomationWorker.cancelForPaused")(function*(
  deps: WorkerDeps,
  scope: PersonalScope,
  run: AutomationRun,
  job: Job,
  attempts: ReadonlyArray<Attempt>,
  runVersion: number,
  jobVersion: number
) {
  const nextAttempt = maxAttemptNumber(attempts, "job") + 1
  const startedAt = String(yield* Clock.currentTimeMillis)
  const start = {
    id: `${run.id}:job:${nextAttempt}`,
    scope,
    runId: run.id,
    jobId: job.id,
    stepId: "job",
    attempt: nextAttempt,
    startedAt,
    kind: "job" as const,
    status: "started" as const,
    request: { reason: "skip-paused" }
  }
  const recorded = yield* Effect.result(deps.executions.recordAttempt(scope, start))
  if (Result.isFailure(recorded)) return
  const nextRun = { ...run, state: { kind: "cancelled" as const, reason: "routine is not enabled for execution" } }
  const nextJob = { ...job, state: nextRun.state }
  yield* Effect.result(deps.executions.update(scope, { expectedRunVersion: runVersion, expectedJobVersion: jobVersion, run: nextRun, job: nextJob }))
})

const failForMissingDelivery = Effect.fn("AutomationWorker.failForMissingDelivery")(function*(
  deps: WorkerDeps,
  scope: PersonalScope,
  run: AutomationRun,
  job: Job,
  attempts: ReadonlyArray<Attempt>,
  runVersion: number,
  jobVersion: number
) {
  const ensured = yield* ensureJobStarted(deps, scope, run, job, attempts)
  const start = ensured.start
  if (start === null || start.status === "completed") return
  const finishedAt = String(yield* Clock.currentTimeMillis)
  const error: AutomationFailure = { code: "missing", message: "Delivery is missing" }
  const completed = { ...start, status: "completed" as const, completion: { finishedAt, error } }
  const nextRun = { ...run, state: { kind: "failed" as const, error } }
  const nextJob = { ...job, state: nextRun.state }
  yield* Effect.result(deps.executions.recordAttempt(scope, completed, { expectedRunVersion: runVersion, expectedJobVersion: jobVersion, run: nextRun, job: nextJob }))
})

const ensureJobStarted = Effect.fn("AutomationWorker.ensureJobStarted")(function*(
  deps: WorkerDeps,
  scope: PersonalScope,
  run: AutomationRun,
  job: Job,
  attempts: ReadonlyArray<Attempt>
) {
  const existing = attempts.filter((attempt) => attempt.kind === "job")
  if (existing.length > 0) {
    const started = existing.find((attempt) => attempt.status === "started") ?? existing[existing.length - 1]!
    return { attempts, start: started as Extract<Attempt, { kind: "job"; status: "started" }> | Extract<Attempt, { kind: "job"; status: "completed" }> }
  }
  const attempt = 1
  const startedAt = String(yield* Clock.currentTimeMillis)
  const start = {
    id: `${run.id}:job:${attempt}`,
    scope,
    runId: run.id,
    jobId: job.id,
    stepId: "job",
    attempt,
    startedAt,
    kind: "job" as const,
    status: "started" as const,
    request: { reason: "worker-run" }
  }
  const recorded = yield* Effect.result(deps.executions.recordAttempt(scope, start))
  if (Result.isFailure(recorded)) return { attempts, start: null as null }
  return { attempts: [...attempts, start as Attempt], start: start as Extract<Attempt, { kind: "job"; status: "started" }> }
})

const runDecisionPhase = Effect.fn("AutomationWorker.runDecisionPhase")(function*(
  deps: WorkerDeps,
  scope: PersonalScope,
  revision: RoutineConfiguration,
  triggerPayload: Schema.Json,
  run: AutomationRun,
  job: Job,
  attempts: ReadonlyArray<Attempt>,
  runVersion: number,
  jobVersion: number
) {
  const decision = revision.process.decision!
  const outcomes = [...decision.outcomes]
  const descriptions = resolveOutcomeDescriptions(revision.configuration, outcomes)
  const decoded = yield* Effect.result(decodeJson(JevDecisionRequest, {
    schemaVersion: 1,
    kind: "jev-request",
    provider: "opencode-zen",
    model: "jev",
    version: "1.13",
    configuration: run.configuration,
    input: run.input,
    outcomes,
    data: triggerPayload
  }))
  if (Result.isFailure(decoded)) {
    yield* failViaJob(deps, scope, run, job, runVersion, jobVersion, { code: "invalid-contract", message: "Decision request does not match its contract" })
    return { finished: true, run, job, attempts, runVersion, jobVersion }
  }
  const request = decoded.success
  const base = maxAttemptNumber(attempts.filter((attempt) => attempt.kind === "decision"), "decision") + 1
  for (let index = 0; index < deps.options.maxAttempts; index += 1) {
    const attemptNumber = base + index
    const startedAt = String(yield* Clock.currentTimeMillis)
    const started = {
      id: `${run.id}:decision:${attemptNumber}`,
      scope,
      runId: run.id,
      jobId: job.id,
      stepId: "decision",
      attempt: attemptNumber,
      startedAt,
      kind: "decision" as const,
      status: "started" as const,
      request
    }
    const recordedStart = yield* Effect.result(deps.executions.recordAttempt(scope, started))
    if (Result.isFailure(recordedStart)) return { finished: true, run, job, attempts, runVersion, jobVersion }
    attempts = [...attempts, started as Attempt]
    const key = deps.options.jev.apiKey ?? (yield* resolveWorkerKey())
    const services = serviceLayerFor(deps)
    const decideWithTimeout = key === null
      ? Effect.fail(new JevDecisionError({ code: "missing-credential", message: "Missing Zen API key" }))
      : classifyJev(request, descriptions, key, {
        ...(deps.options.jev.endpoint === undefined ? {} : { endpoint: deps.options.jev.endpoint }),
        timeoutMs: deps.options.jev.timeoutMs ?? deps.options.attemptTimeoutMs,
        maxRetries: 0,
        ...(deps.options.jev.questionId === undefined ? {} : { questionId: deps.options.jev.questionId }),
        ...(deps.options.jev.instructions === undefined ? {} : { instructions: deps.options.jev.instructions })
      }).pipe(Effect.provide(services), Effect.timeoutOption(Duration.millis(deps.options.attemptTimeoutMs)))
    const settled = yield* Effect.result(decideWithTimeout)
    const finishedAt = String(yield* Clock.currentTimeMillis)
    if (Result.isSuccess(settled)) {
      const maybe = settled.success
      if (Option.isNone(maybe)) {
        const failure: AutomationFailure = { code: "timeout", message: "Jev decision exceeded its deadline" }
        const completed = { ...started, status: "completed" as const, finishedAt, error: failure }
        if (index + 1 < deps.options.maxAttempts) {
          yield* Effect.result(deps.executions.recordAttempt(scope, completed))
          attempts = [...attempts.slice(0, attempts.length - 1), completed as Attempt]
          yield* Effect.sleep(Duration.millis(Math.min(deps.options.baseBackoffMs * 2 ** index, 2000)))
          continue
        }
        const nextRun = { ...run, state: { kind: "failed" as const, error: failure }, actions: [] as ReadonlyArray<ActionOutcome> }
        const nextJob = { ...job, state: nextRun.state }
        yield* Effect.result(deps.executions.recordAttempt(scope, completed, { expectedRunVersion: runVersion, expectedJobVersion: jobVersion, run: nextRun, job: nextJob }))
        return { finished: true, run: nextRun, job: nextJob, attempts: [...attempts.slice(0, attempts.length - 1), completed as Attempt], runVersion: runVersion + 1, jobVersion: jobVersion + 1 }
      }
      const result = maybe.value
      const completed = { ...started, status: "completed" as const, finishedAt, result }
      if (result.kind === "abstained") {
        const nextRun = { ...run, state: { kind: "unresolved" as const, reason: result.reason }, decision: result, actions: [] as ReadonlyArray<ActionOutcome> }
        const nextJob = { ...job, state: nextRun.state }
        yield* Effect.result(deps.executions.recordAttempt(scope, completed, { expectedRunVersion: runVersion, expectedJobVersion: jobVersion, run: nextRun, job: nextJob }))
        return { finished: true, run: nextRun, job: nextJob, attempts: [...attempts.slice(0, attempts.length - 1), completed as Attempt], runVersion: runVersion + 1, jobVersion: jobVersion + 1 }
      }
      const resolved = yield* Effect.result(deps.registry.resolveSelectedActions(revision, triggerPayload, result))
      if (Result.isFailure(resolved)) {
        yield* Effect.result(deps.executions.recordAttempt(scope, completed))
        yield* failViaJob(deps, scope, run, job, runVersion, jobVersion, { code: resolved.failure.code, message: resolved.failure.message })
        return { finished: true, run, job, attempts: [...attempts.slice(0, attempts.length - 1), completed as Attempt], runVersion, jobVersion }
      }
      const grant = checkGrants(deps.registry, run, resolved.success.actions)
      if (grant !== null) {
        yield* Effect.result(deps.executions.recordAttempt(scope, completed))
        yield* failViaJob(deps, scope, run, job, runVersion, jobVersion, { code: "denied", message: `Action ${grant.stepId} is outside the run grants` })
        return { finished: true, run, job, attempts: [...attempts.slice(0, attempts.length - 1), completed as Attempt], runVersion, jobVersion }
      }
      const planned = resolved.success.actions.map((action) => ({ kind: "planned" as const, stepId: action.stepId, action: action.action, arguments: action.arguments }))
      const nextRun = { ...run, state: { kind: "running" as const }, decision: result, actions: planned }
      const nextJob = { ...job, state: nextRun.state }
      const recorded = yield* Effect.result(deps.executions.recordAttempt(scope, completed, { expectedRunVersion: runVersion, expectedJobVersion: jobVersion, run: nextRun, job: nextJob }))
      if (Result.isFailure(recorded)) return { finished: true, run, job, attempts: [...attempts.slice(0, attempts.length - 1), completed as Attempt], runVersion, jobVersion }
      return { finished: false, run: nextRun, job: nextJob, attempts: [...attempts.slice(0, attempts.length - 1), completed as Attempt], runVersion: runVersion + 1, jobVersion: jobVersion + 1 }
    }
    const failure = toWorkerDecisionFailure(settled.failure)
    const completed = { ...started, status: "completed" as const, finishedAt, error: failure }
    const retryable = isRetryableDecisionError(settled.failure)
    if (retryable && index + 1 < deps.options.maxAttempts) {
      yield* Effect.result(deps.executions.recordAttempt(scope, completed))
      attempts = [...attempts.slice(0, attempts.length - 1), completed as Attempt]
      yield* Effect.sleep(Duration.millis(Math.min(deps.options.baseBackoffMs * 2 ** index, 2000)))
      continue
    }
    const nextRun = { ...run, state: { kind: "failed" as const, error: failure }, actions: [] as ReadonlyArray<ActionOutcome> }
    const nextJob = { ...job, state: nextRun.state }
    yield* Effect.result(deps.executions.recordAttempt(scope, completed, { expectedRunVersion: runVersion, expectedJobVersion: jobVersion, run: nextRun, job: nextJob }))
    return { finished: true, run: nextRun, job: nextJob, attempts: [...attempts.slice(0, attempts.length - 1), completed as Attempt], runVersion: runVersion + 1, jobVersion: jobVersion + 1 }
  }
  return { finished: true, run, job, attempts, runVersion, jobVersion }
})

const runActionPhase = Effect.fn("AutomationWorker.runActionPhase")(function*(
  deps: WorkerDeps,
  scope: PersonalScope,
  revision: RoutineConfiguration,
  triggerPayload: Schema.Json,
  run: AutomationRun,
  job: Job,
  attempts: ReadonlyArray<Attempt>,
  runVersion: number,
  jobVersion: number,
  jobStart: unknown
) {
  const resolved = yield* Effect.result(deps.registry.resolveSelectedActions(revision, triggerPayload, run.decision))
  if (Result.isFailure(resolved)) {
    if (run.decision?.kind === "abstained") {
      const nextRun = { ...run, state: { kind: "unresolved" as const, reason: run.decision.reason }, actions: [] as ReadonlyArray<ActionOutcome> }
      const nextJob = { ...job, state: nextRun.state }
      yield* Effect.result(deps.executions.update(scope, { expectedRunVersion: runVersion, expectedJobVersion: jobVersion, run: nextRun, job: nextJob }))
      return
    }
    yield* failViaJob(deps, scope, run, job, runVersion, jobVersion, { code: resolved.failure.code, message: resolved.failure.message })
    return
  }
  if (resolved.success.selection.kind === "unresolved") {
    const reason = resolved.success.selection.reason
    const decision = run.decision
    if (decision?.kind === "abstained") {
      const nextRun = { ...run, state: { kind: "unresolved" as const, reason }, decision, actions: [] as ReadonlyArray<ActionOutcome> }
      const nextJob = { ...job, state: nextRun.state }
      yield* Effect.result(deps.executions.update(scope, { expectedRunVersion: runVersion, expectedJobVersion: jobVersion, run: nextRun, job: nextJob }))
      return
    }
    yield* failViaJob(deps, scope, run, job, runVersion, jobVersion, { code: "unresolved-selection", message: reason })
    return
  }
  const outcomeId = resolved.success.selection.outcomeId
  const steps = resolved.success.actions
  if (run.mode === "preview") {
    yield* runPreviewSkips(deps, scope, revision, run, job, attempts, runVersion, jobVersion, jobStart, steps, outcomeId)
    return
  }
  let currentRun = run
  let currentJob = job
  let currentRunVersion = runVersion
  let currentJobVersion = jobVersion
  let currentAttempts = attempts
  const results: Array<Schema.Json> = []
  for (const action of steps) {
    const done = findCompletedActionOutcome(currentAttempts, action.stepId)
    if (done !== null && (done.kind === "succeeded" || done.kind === "skipped")) {
      if (done.kind === "succeeded") results.push(done.result)
      continue
    }
    const grant = checkSingleGrant(deps.registry, currentRun, action.stepId, action.action, action.integrationId)
    if (grant !== null) {
      yield* failViaJob(deps, scope, currentRun, currentJob, currentRunVersion, currentJobVersion, { code: "denied", message: `Action ${action.stepId} is outside the run grants` })
      return
    }
    const base = maxActionAttempt(currentAttempts, action.stepId) + 1
    let settled = false
    for (let index = 0; index < deps.options.maxAttempts; index += 1) {
      const attemptNumber = base + index
      const startedAt = String(yield* Clock.currentTimeMillis)
      const started = {
        id: `${run.id}:${action.stepId}:${attemptNumber}`,
        scope,
        runId: run.id,
        jobId: job.id,
        stepId: action.stepId,
        attempt: attemptNumber,
        startedAt,
        kind: "action" as const,
        status: "started" as const,
        integration: stepIntegration(revision, action.stepId) ?? { id: action.integrationId, definition: action.action },
        action: action.action,
        arguments: action.arguments
      }
      const recordedStart = yield* Effect.result(deps.executions.recordAttempt(scope, started))
      if (Result.isFailure(recordedStart)) return
      currentAttempts = [...currentAttempts, started as Attempt]
      const invoked = yield* Effect.result(
        deps.registry.invokeAction({
          configuration: revision,
          stepId: action.stepId,
          triggerPayload,
          ...(currentRun.decision === undefined ? {} : { decision: currentRun.decision }),
          mode: "live"
        }, currentRun.authority).pipe(Effect.provide(serviceLayerFor(deps)), Effect.timeoutOption(Duration.millis(deps.options.attemptTimeoutMs)))
      )
      const finishedAt = String(yield* Clock.currentTimeMillis)
      if (Result.isSuccess(invoked) && Option.isSome(invoked.success)) {
        const outcome = { kind: "succeeded" as const, stepId: action.stepId, action: action.action, result: invoked.success.value as Schema.Json }
        const completed = { ...started, status: "completed" as const, finishedAt, outcome }
        const nextActions = mergeOutcomes(currentRun.actions, [outcome])
        const nextRun = { ...currentRun, state: { kind: "running" as const }, actions: nextActions }
        const nextJob = { ...currentJob, state: nextRun.state }
        const recorded = yield* Effect.result(deps.executions.recordAttempt(scope, completed, { expectedRunVersion: currentRunVersion, expectedJobVersion: currentJobVersion, run: nextRun, job: nextJob }))
        if (Result.isFailure(recorded)) return
        currentAttempts = [...currentAttempts.slice(0, currentAttempts.length - 1), completed as Attempt]
        currentRun = nextRun
        currentJob = nextJob
        currentRunVersion += 1
        currentJobVersion += 1
        results.push(invoked.success.value as Schema.Json)
        settled = true
        break
      }
      const timedOut = Result.isSuccess(invoked) && Option.isNone(invoked.success)
      const invokeError = timedOut
        ? new AutomationError({ code: "handler-failed", message: "Action exceeded its deadline", failure: { code: "timeout", message: "Action exceeded its deadline" } })
        : (invoked as Extract<typeof invoked, { _tag: string }> as unknown as { failure: AutomationError }).failure as AutomationError
      const failure = toActionFailure(invokeError, action.stepId)
      const outcome = { kind: "failed" as const, stepId: action.stepId, action: action.action, error: failure }
      const completed = { ...started, status: "completed" as const, finishedAt, outcome }
      const retryable = timedOut ? true : isRetryableActionError(invokeError)
      if (retryable && index + 1 < deps.options.maxAttempts) {
        yield* Effect.result(deps.executions.recordAttempt(scope, completed))
        currentAttempts = [...currentAttempts.slice(0, currentAttempts.length - 1), completed as Attempt]
        yield* Effect.sleep(Duration.millis(Math.min(deps.options.baseBackoffMs * 2 ** index, 2000)))
        continue
      }
      const nextActions = mergeOutcomes(currentRun.actions, [outcome])
      const nextRun = { ...currentRun, state: { kind: "failed" as const, error: failure }, actions: nextActions }
      const nextJob = { ...currentJob, state: nextRun.state }
      yield* Effect.result(deps.executions.recordAttempt(scope, completed, { expectedRunVersion: currentRunVersion, expectedJobVersion: currentJobVersion, run: nextRun, job: nextJob }))
      return
    }
    if (!settled) return
  }
  const result = { outcomeId, results }
  const start = jobStart as Extract<Attempt, { kind: "job"; status: "started" }> | Extract<Attempt, { kind: "job"; status: "completed" }> | null
  if (start === null || start.status === "completed") return
  const finishedAt = String(yield* Clock.currentTimeMillis)
  const completed = { ...start, status: "completed" as const, completion: { finishedAt, result } }
  const nextRun = { ...currentRun, state: { kind: "succeeded" as const, result } }
  const nextJob = { ...currentJob, state: nextRun.state }
  yield* Effect.result(deps.executions.recordAttempt(scope, completed, { expectedRunVersion: currentRunVersion, expectedJobVersion: currentJobVersion, run: nextRun, job: nextJob }))
})

const runPreviewSkips = Effect.fn("AutomationWorker.runPreviewSkips")(function*(
  deps: WorkerDeps,
  scope: PersonalScope,
  revision: RoutineConfiguration,
  run: AutomationRun,
  job: Job,
  attempts: ReadonlyArray<Attempt>,
  runVersion: number,
  jobVersion: number,
  jobStart: unknown,
  steps: ReadonlyArray<{ readonly stepId: string; readonly action: DefinitionReference; readonly integrationId: string; readonly arguments: Schema.Json }>,
  outcomeId: string
) {
  void revision
  let currentRun = run
  let currentJob = job
  let currentRunVersion = runVersion
  let currentJobVersion = jobVersion
  let currentAttempts = attempts
  if (currentRun.state.kind === "queued") {
    const planned = steps.map((action) => ({ kind: "planned" as const, stepId: action.stepId, action: action.action, arguments: action.arguments }))
    const nextRun = { ...currentRun, state: { kind: "running" as const }, actions: planned }
    const nextJob = { ...currentJob, state: nextRun.state }
    const moved = yield* Effect.result(deps.executions.update(scope, { expectedRunVersion: currentRunVersion, expectedJobVersion: currentJobVersion, run: nextRun, job: nextJob }))
    if (Result.isFailure(moved)) return
    currentRun = nextRun
    currentJob = nextJob
    currentRunVersion += 1
    currentJobVersion += 1
  }
  const skipped: Array<Extract<ActionOutcome, { kind: "skipped" }>> = []
  for (const action of steps) {
    if (hasCompletedAction(currentAttempts, action.stepId, ["skipped"])) {
      const existing = findCompletedActionOutcome(currentAttempts, action.stepId)
      if (existing !== null && existing.kind === "skipped") skipped.push(existing)
      continue
    }
    const attemptNumber = maxActionAttempt(currentAttempts, action.stepId) + 1
    const startedAt = String(yield* Clock.currentTimeMillis)
    const started = {
      id: `${run.id}:${action.stepId}:${attemptNumber}`,
      scope,
      runId: run.id,
      jobId: job.id,
      stepId: action.stepId,
      attempt: attemptNumber,
      startedAt,
      kind: "action" as const,
      status: "started" as const,
      integration: stepIntegration(revision, action.stepId) ?? { id: action.integrationId, definition: action.action },
      action: action.action,
      arguments: action.arguments
    }
    const recordedStart = yield* Effect.result(deps.executions.recordAttempt(scope, started))
    if (Result.isFailure(recordedStart)) return
    currentAttempts = [...currentAttempts, started as Attempt]
    const finishedAt = String(yield* Clock.currentTimeMillis)
    const outcome = { kind: "skipped" as const, stepId: action.stepId, action: action.action, reason: "preview" }
    const completed = { ...started, status: "completed" as const, finishedAt, outcome }
    const nextActions = mergeOutcomes(currentRun.actions, [outcome])
    const nextRun = { ...currentRun, state: { kind: "running" as const }, actions: nextActions }
    const nextJob = { ...currentJob, state: nextRun.state }
    const recorded = yield* Effect.result(deps.executions.recordAttempt(scope, completed, { expectedRunVersion: currentRunVersion, expectedJobVersion: currentJobVersion, run: nextRun, job: nextJob }))
    if (Result.isFailure(recorded)) return
    currentAttempts = [...currentAttempts.slice(0, currentAttempts.length - 1), completed as Attempt]
    currentRun = nextRun
    currentJob = nextJob
    currentRunVersion += 1
    currentJobVersion += 1
    skipped.push(outcome)
  }
  const result = { preview: true, outcomeId }
  const start = jobStart as Extract<Attempt, { kind: "job"; status: "started" }> | Extract<Attempt, { kind: "job"; status: "completed" }> | null
  if (start === null || start.status === "completed") return
  const finishedAt = String(yield* Clock.currentTimeMillis)
  const completed = { ...start, status: "completed" as const, completion: { finishedAt, result } }
  const nextRun = { ...currentRun, state: { kind: "succeeded" as const, result }, actions: skipped }
  const nextJob = { ...currentJob, state: nextRun.state }
  yield* Effect.result(deps.executions.recordAttempt(scope, completed, { expectedRunVersion: currentRunVersion, expectedJobVersion: currentJobVersion, run: nextRun, job: nextJob }))
})

const failViaJob = Effect.fn("AutomationWorker.failViaJob")(function*(
  deps: WorkerDeps,
  scope: PersonalScope,
  run: AutomationRun,
  job: Job,
  runVersion: number,
  jobVersion: number,
  error: AutomationFailure
) {
  const history = yield* deps.executions.history(scope, run.id)
  if (history === null) return
  if (history.run.value.state.kind !== "queued" && history.run.value.state.kind !== "running") return
  const currentAttempts = history.attempts
  const started = currentAttempts.find((attempt) => attempt.kind === "job" && attempt.status === "started")
  if (started === undefined) {
    const attemptNumber = maxAttemptNumber(currentAttempts, "job") + 1
    const startedAt = String(yield* Clock.currentTimeMillis)
    const start = {
      id: `${run.id}:job:${attemptNumber}`,
      scope,
      runId: run.id,
      jobId: job.id,
      stepId: "job",
      attempt: attemptNumber,
      startedAt,
      kind: "job" as const,
      status: "started" as const,
      request: { reason: "worker-fail" }
    }
    const recordedStart = yield* Effect.result(deps.executions.recordAttempt(scope, start))
    if (Result.isFailure(recordedStart)) return
    const finishedAt = String(yield* Clock.currentTimeMillis)
    const completed = { ...start, status: "completed" as const, completion: { finishedAt, error } }
    const nextRun = { ...history.run.value, state: { kind: "failed" as const, error } }
    const nextJob = { ...history.job.value, state: nextRun.state }
    yield* Effect.result(deps.executions.recordAttempt(scope, completed, { expectedRunVersion: history.run.version, expectedJobVersion: history.job.version, run: nextRun, job: nextJob }))
    return
  }
  const finishedAt = String(yield* Clock.currentTimeMillis)
  const completed = { ...(started as Extract<Attempt, { kind: "job"; status: "started" }>), status: "completed" as const, completion: { finishedAt, error } }
  const nextRun = { ...history.run.value, state: { kind: "failed" as const, error } }
  const nextJob = { ...history.job.value, state: nextRun.state }
  yield* Effect.result(deps.executions.recordAttempt(scope, completed, { expectedRunVersion: history.run.version, expectedJobVersion: history.job.version, run: nextRun, job: nextJob }))
})

function maxAttemptNumber(attempts: ReadonlyArray<Attempt>, stepId: string): number {
  let max = 0
  for (const attempt of attempts) {
    if (attempt.stepId === stepId && attempt.attempt > max) max = attempt.attempt
  }
  return max
}

function maxActionAttempt(attempts: ReadonlyArray<Attempt>, stepId: string): number {
  return maxAttemptNumber(attempts.filter((attempt) => attempt.kind === "action"), stepId)
}

function hasCompletedAction(attempts: ReadonlyArray<Attempt>, stepId: string, kinds: ReadonlyArray<string>): boolean {
  return attempts.some((attempt) => attempt.kind === "action" && attempt.status === "completed" && attempt.stepId === stepId && kinds.includes(attempt.outcome.kind))
}

function findCompletedActionOutcome(attempts: ReadonlyArray<Attempt>, stepId: string): ActionOutcome | null {
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const attempt = attempts[index]!
    if (attempt.kind === "action" && attempt.status === "completed" && attempt.stepId === stepId) return attempt.outcome
  }
  return null
}

function mergeOutcomes(
  current: ReadonlyArray<ActionOutcome>,
  completed: ReadonlyArray<ActionOutcome>
): ReadonlyArray<ActionOutcome> {
  const next = [...current]
  for (const outcome of completed) {
    const index = next.findIndex((item) => item.stepId === outcome.stepId)
    if (index === -1) next.push(outcome)
    else next[index] = outcome
  }
  return next
}

function stepIntegration(revision: RoutineConfiguration, stepId: string): { readonly id: string; readonly definition: DefinitionReference } | null {
  for (const steps of Object.values(revision.process.actions)) {
    for (const step of steps) {
      if (step.id === stepId) return step.integration
    }
  }
  return null
}

function requiredCapabilities(registry: AutomationRegistry<ConfigurationRepository | CredentialRepository | HttpClient.HttpClient>, action: DefinitionReference): ReadonlyArray<string> | null {
  for (const entry of registry.catalog().definitions) {
    if (entry.kind === "action" && sameDefinition(entry.definition, action)) return [...entry.capabilities]
  }
  return null
}

function checkGrants(
  registry: AutomationRegistry<ConfigurationRepository | CredentialRepository | HttpClient.HttpClient>,
  run: AutomationRun,
  actions: ReadonlyArray<{ readonly stepId: string; readonly action: DefinitionReference; readonly integrationId: string }>
): { readonly stepId: string } | null {
  for (const action of actions) {
    const capabilities = requiredCapabilities(registry, action.action)
    if (capabilities === null) return { stepId: action.stepId }
    const granted = run.authority.integrationIds.includes(action.integrationId) && run.authority.actionGrants.some((grant) =>
      sameDefinition(grant.action, action.action) && grant.integrationId === action.integrationId &&
      capabilities.every((capability) => grant.capabilities.includes(capability)))
    if (!granted) return { stepId: action.stepId }
  }
  return null
}

function checkSingleGrant(
  registry: AutomationRegistry<ConfigurationRepository | CredentialRepository | HttpClient.HttpClient>,
  run: AutomationRun,
  stepId: string,
  action: DefinitionReference,
  integrationId: string
): { readonly stepId: string } | null {
  const capabilities = requiredCapabilities(registry, action)
  if (capabilities === null) return { stepId }
  const granted = run.authority.integrationIds.includes(integrationId) && run.authority.actionGrants.some((grant) =>
    sameDefinition(grant.action, action) && grant.integrationId === integrationId &&
    capabilities.every((capability) => grant.capabilities.includes(capability)))
  return granted ? null : { stepId }
}

function isRetryableFailureCode(failure: AutomationFailure): boolean {
  if (failure.code === "rate-limited" || failure.code === "transient" || failure.code === "timeout" || failure.code === "connection-failed") return true
  if (failure.code === "api-error") {
    const details = failure.details
    if (details !== undefined && details !== null && typeof details === "object" && !Array.isArray(details) && "status" in details) {
      const status = (details as Record<string, unknown>)["status"]
      if (typeof status === "number") return status >= 500
    }
    return true
  }
  return false
}

function toWorkerDecisionFailure(error: unknown): AutomationFailure {
  if (error instanceof JevDecisionError) return toDecisionFailure(error)
  if (error instanceof AutomationError) {
    if (error.code === "handler-failed" && error.failure !== undefined) return error.failure
    return { code: error.code, message: error.message }
  }
  return { code: "transient", message: "Decision attempt failed" }
}

const resolveWorkerKey = Effect.fn("AutomationWorker.resolveKey")(function*() {
  for (const name of ["OPENCODE_ZEN_API_KEY", "OPENCODE_API_KEY"] as const) {
    const candidate: Option.Option<string> = yield* Config.option(Config.String(name)).pipe(Effect.catch(() => Effect.succeed(Option.none<string>())))
    if (Option.isSome(candidate) && candidate.value.length > 0) return candidate.value as string
  }
  return null as string | null
})
