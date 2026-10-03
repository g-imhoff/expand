import { Context, Effect, Layer, Schema } from "effect"
import { AutomationRun, deriveSelectedActions, LocalId, PersonalScope, PositiveVersion } from "@expand/contracts/automation"
import { SqlClient } from "effect/sql/SqlClient"
import { ConfigurationRepository } from "./configuration-repository.js"
import { DatabaseReady } from "../migrations/sqlite.js"
import { canonical, encodeJson, decode, guard, readJson, same, protectStorage, validateRun, StorageError, Attempt, Delivery, Job } from "./persistence-models.js"

export interface Target { readonly jobId: string; readonly run: AutomationRun }
export interface Ingestion { readonly delivery: Delivery; readonly raw: Uint8Array; readonly targets: ReadonlyArray<Target> }
export interface Accepted { readonly deliveryId: string; readonly jobIds: ReadonlyArray<string>; readonly runIds: ReadonlyArray<string> }
export interface RecordVersion<A> { readonly sequence: number; readonly version: number; readonly value: A }
export interface Summary { readonly expectedRunVersion: number; readonly expectedJobVersion: number; readonly run: AutomationRun; readonly job: Job }
export interface History { readonly run: RecordVersion<AutomationRun>; readonly job: RecordVersion<Job>; readonly attempts: ReadonlyArray<Attempt> }
export interface Query { readonly limit: number; readonly cursor?: string; readonly routineId?: string; readonly deliveryId?: string; readonly mode?: "preview" | "live"; readonly state?: AutomationRun["state"]["kind"] }
export interface Page<A> { readonly items: ReadonlyArray<A>; readonly cursor: string | null }
export class ExecutionRepository extends Context.Service<ExecutionRepository, {
  readonly ingest: (input: Ingestion) => Effect.Effect<Accepted, StorageError>
  readonly recordAttempt: (scope: PersonalScope, attempt: Attempt, summary?: Summary) => Effect.Effect<void, StorageError>
  readonly update: (scope: PersonalScope, summary: Summary) => Effect.Effect<void, StorageError>
  readonly replay: (scope: PersonalScope, deliveryId: string, key: string, target: Target) => Effect.Effect<Accepted, StorageError>
  readonly getDelivery: (scope: PersonalScope, id: string) => Effect.Effect<{ value: Delivery; raw: Uint8Array; sequence: number } | null, StorageError>
  readonly getRun: (scope: PersonalScope, id: string) => Effect.Effect<RecordVersion<AutomationRun> | null, StorageError>
  readonly getJob: (scope: PersonalScope, id: string) => Effect.Effect<RecordVersion<Job> | null, StorageError>
  readonly history: (scope: PersonalScope, id: string) => Effect.Effect<History | null, StorageError>
  readonly listRuns: (scope: PersonalScope, query: Query) => Effect.Effect<Page<RecordVersion<AutomationRun>>, StorageError>
  readonly listJobs: (scope: PersonalScope, query: Query) => Effect.Effect<Page<RecordVersion<Job>>, StorageError>
}>()("expand/ExecutionRepository", {
  make: Effect.gen(function* () {
    yield* DatabaseReady
    const sql = yield* SqlClient
    const config = yield* ConfigurationRepository
    const scopeId = Effect.fn(function*(scope: PersonalScope, id: string) { yield* decode(PersonalScope, scope); yield* decode(LocalId, id) })
    const getDelivery = Effect.fn(function*(scope: PersonalScope, id: string) {
      yield* scopeId(scope, id)
      const rows = yield* sql<DeliveryRow>`SELECT * FROM automation_deliveries WHERE owner_id=${scope.ownerId} AND project_id=${scope.projectId} AND id=${id}`
      if (!rows[0]) return null
      const row = rows[0]; const value = yield* readJson(Delivery, row.json)
      yield* guard(value.id === id && same(value.scope, scope) && value.integration.id === row.integration_id && value.externalId === row.external_id && row.raw instanceof Uint8Array)
      yield* decode(PositiveVersion, row.seq)
      return { value, raw: new Uint8Array(row.raw), sequence: row.seq }
    })
    const getRun = Effect.fn(function*(scope: PersonalScope, id: string) {
      yield* scopeId(scope, id)
      const rows = yield* sql<ExecutionRow>`SELECT * FROM automation_runs WHERE owner_id=${scope.ownerId} AND project_id=${scope.projectId} AND id=${id}`
      if (!rows[0]) return null
      const row = rows[0]; const value = yield* readJson(AutomationRun, row.json)
      const delivery = yield* getDelivery(scope, row.delivery_id)
      const revision = yield* config.getRevision(scope, row.routine_id, row.revision)
      yield* guard(delivery !== null && revision !== null, "missing")
      yield* validateRun(value, delivery!.value, revision!)
      yield* guard(value.id === id && value.configuration.routineId === row.routine_id && value.configuration.revision === row.revision && value.input.id === row.delivery_id && value.mode === row.mode && value.state.kind === row.state)
      yield* decode(PositiveVersion, row.version); yield* decode(PositiveVersion, row.seq)
      return { value, version: row.version, sequence: row.seq }
    })
    const getJob = Effect.fn(function*(scope: PersonalScope, id: string) {
      yield* scopeId(scope, id)
      const rows = yield* sql<ExecutionRow>`SELECT * FROM automation_jobs WHERE owner_id=${scope.ownerId} AND project_id=${scope.projectId} AND id=${id}`
      if (!rows[0]) return null
      const row = rows[0]; const value = yield* readJson(Job, row.json)
      const run = yield* getRun(scope, value.runId)
      yield* guard(run !== null && value.id === id && same(value.scope, scope) && value.inputId === row.delivery_id && value.configuration.routineId === row.routine_id && value.configuration.revision === row.revision && value.mode === row.mode && value.state.kind === row.state)
      yield* guard(same(value.configuration, run!.value.configuration) && value.inputId === run!.value.input.id && value.mode === run!.value.mode && same(value.state, run!.value.state))
      const links = yield* sql<{ job_id: string }>`SELECT job_id FROM automation_runs WHERE owner_id=${scope.ownerId} AND project_id=${scope.projectId} AND id=${value.runId}`
      yield* guard(links[0]?.job_id === id)
      yield* decode(PositiveVersion, row.version); yield* decode(PositiveVersion, row.seq)
      return { value, version: row.version, sequence: row.seq }
    })
    const originalIds = Effect.fn(function*(scope: PersonalScope, deliveryId: string, key: string) {
      const rows = yield* sql<{ id: string }>`SELECT id FROM automation_jobs WHERE owner_id=${scope.ownerId} AND project_id=${scope.projectId} AND delivery_id=${deliveryId} AND replay_key=${key} ORDER BY seq`
      const jobIds: string[] = []; const runIds: string[] = []
      for (const row of rows) { const job = yield* getJob(scope, row.id); yield* guard(job !== null, "missing"); jobIds.push(row.id); runIds.push(job!.value.runId) }
      return { deliveryId, jobIds, runIds }
    })
    const insertTarget = Effect.fn(function*(delivery: Delivery, target: Target, key: string) {
      yield* decode(LocalId, target.jobId)
      const revision = yield* config.getRevision(delivery.scope, target.run.configuration.routineId, target.run.configuration.revision)
      yield* guard(revision !== null, "missing")
      const run = yield* validateRun(target.run, delivery, revision!)
      yield* guard(run.state.kind === "queued" && run.decision === undefined && run.actions.every((value) => value.kind === "planned"))
      const scope = delivery.scope
      const job: Job = { id: target.jobId, scope, runId: run.id, configuration: run.configuration, inputId: delivery.id, mode: run.mode, state: run.state, metadata: {} }
      const columns = { owner_id: scope.ownerId, project_id: scope.projectId, delivery_id: delivery.id, routine_id: run.configuration.routineId, revision: run.configuration.revision, mode: run.mode, state: run.state.kind, version: 1 }
      yield* sql`INSERT INTO automation_jobs ${sql.insert({ ...columns, id: job.id, replay_key: key, json: encodeJson(job) })}`
      yield* sql`INSERT INTO automation_runs ${sql.insert({ ...columns, id: run.id, job_id: job.id, json: encodeJson(run) })}`
    })
    const ingest = (input: Ingestion) => protectStorage(sql.withTransaction(Effect.gen(function* () {
      const delivery = yield* decode(Delivery, input.delivery)
      yield* guard(input.raw instanceof Uint8Array && Array.isArray(input.targets))
      for (const target of input.targets) { yield* decode(LocalId, target.jobId); yield* decode(AutomationRun, target.run) }
      const scope = delivery.scope
      const natural = yield* sql<{ id: string }>`SELECT id FROM automation_deliveries WHERE owner_id=${scope.ownerId} AND project_id=${scope.projectId} AND integration_id=${delivery.integration.id} AND external_id=${delivery.externalId}`
      if (natural[0]) {
        const existing = yield* getDelivery(scope, natural[0].id)
        yield* guard(existing !== null, "missing")
        yield* guard(same(existing!.value, { ...delivery, id: existing!.value.id }) && same([...existing!.raw], [...input.raw]), "conflict")
        return yield* originalIds(scope, existing!.value.id, "initial")
      }
      const integration = yield* config.getIntegration(scope, delivery.integration.id)
      yield* guard(integration !== null && same(integration.configuration.definition, delivery.integration.definition), "missing")
      yield* guard(new Set(input.targets.map((target) => encodeJson([target.run.configuration.routineId, target.run.mode]))).size === input.targets.length)
      yield* sql`INSERT INTO automation_deliveries ${sql.insert({ owner_id: scope.ownerId, project_id: scope.projectId, id: delivery.id, integration_id: delivery.integration.id, external_id: delivery.externalId, raw: input.raw, json: encodeJson(delivery) })}`
      for (const target of input.targets) yield* insertTarget(delivery, target, "initial")
      return yield* originalIds(scope, delivery.id, "initial")
    })))
    const validateAttempt = Effect.fn(function*(scope: PersonalScope, input: unknown) {
      const attempt = yield* decode(Attempt, input)
      yield* guard(same(attempt.scope, scope))
      const run = yield* getRun(scope, attempt.runId); const job = yield* getJob(scope, attempt.jobId)
      yield* guard(run !== null && job !== null && job.value.runId === attempt.runId, "missing")
      const revision = yield* config.getRevision(scope, run!.value.configuration.routineId, run!.value.configuration.revision)
      yield* guard(revision !== null, "missing")
      if (attempt.kind === "job") {
        yield* guard(attempt.stepId === "job")
        if (attempt.status === "completed") yield* guard(Object.hasOwn(attempt.completion, "result") !== Object.hasOwn(attempt.completion, "error"))
      } else if (attempt.kind === "decision") {
        yield* guard(attempt.stepId === "decision" && revision!.process.decision !== undefined && same(attempt.request.configuration, run!.value.configuration) && same(attempt.request.input, run!.value.input) && same(attempt.request.outcomes, revision!.process.decision!.outcomes))
        if (attempt.status === "completed") {
          yield* guard(Object.hasOwn(attempt, "result") !== Object.hasOwn(attempt, "error"))
          if (attempt.result?.kind === "selected") yield* guard(attempt.request.outcomes.includes(attempt.result.outcomeId))
        }
      } else {
        const step = Object.values(revision!.process.actions).flat().find((step) => step.id === attempt.stepId)
        yield* guard(step !== undefined && same(step.action, attempt.action) && same(step.integration, attempt.integration))
        yield* guard(run!.value.authority.integrationIds.includes(attempt.integration.id) && run!.value.authority.actionGrants.some((grant) => grant.integrationId === attempt.integration.id && same(grant.action, attempt.action)))
        if (attempt.status === "completed") yield* guard(attempt.outcome.kind !== "planned" && attempt.outcome.stepId === attempt.stepId && same(attempt.outcome.action, attempt.action))
      }
      return attempt
    })
    const readAttempts = Effect.fn(function*(scope: PersonalScope, runId: string) {
      const attempts: Attempt[] = []
      for (const kind of ["job", "decision", "action"] as const) {
        const rows = yield* sql<AttemptRow>`SELECT * FROM ${sql(`automation_${kind}_attempts`)} WHERE owner_id=${scope.ownerId} AND project_id=${scope.projectId} AND run_id=${runId} ORDER BY seq`
        for (const row of rows) {
          const attempt = yield* readJson(Attempt, row.json).pipe(Effect.flatMap((value) => validateAttempt(scope, value)))
          yield* guard(attempt.kind === kind && attempt.id === row.id && attempt.jobId === row.job_id && attempt.runId === row.run_id && attempt.stepId === row.step_id && attempt.attempt === row.attempt && attempt.status === row.status)
          attempts.push(attempt)
        }
      }
      return attempts
    })
    const validateSummary = Effect.fn(function*(scope: PersonalScope, summary: Summary, checkVersions: boolean) {
      const run = yield* decode(AutomationRun, summary.run); const job = yield* decode(Job, summary.job)
      const currentRun = yield* getRun(scope, run.id); const currentJob = yield* getJob(scope, job.id)
      yield* guard(currentRun !== null && currentJob !== null && currentJob.value.runId === run.id, "missing")
      yield* guard(same(run.scope, scope) && same(job.scope, scope) && same(immutableRun(run), immutableRun(currentRun!.value)) && same(immutableJob(job), immutableJob(currentJob!.value)) && same(job.state, run.state))
      yield* decode(PositiveVersion, summary.expectedRunVersion); yield* decode(PositiveVersion, summary.expectedJobVersion)
      if (checkVersions) yield* guard(currentRun!.version === summary.expectedRunVersion && currentJob!.version === summary.expectedJobVersion, "conflict")
      if (isTerminal(currentRun!.value)) yield* guard(same(run, currentRun!.value), "conflict")
      const revision = yield* config.getRevision(scope, run.configuration.routineId, run.configuration.revision)
      const original = yield* getDelivery(scope, run.input.id)
      yield* guard(revision !== null && original !== null, "missing")
      yield* validateRun(run, original!.value, revision!)
      const attempts = yield* readAttempts(scope, run.id)
      const decisions = attempts.filter((value): value is Extract<Attempt, { kind: "decision"; status: "completed" }> => value.kind === "decision" && value.status === "completed")
      if (run.decision) yield* guard(decisions.some((value) => same(value.result, run.decision)))
      const selection = yield* deriveSelectedActions(revision!.process, run.decision).pipe(Effect.mapError(() => new StorageError({ code: "invalid", message: "Invalid decision linkage" })))
      yield* guard(new Set(run.actions.map((value) => value.stepId)).size === run.actions.length)
      for (const outcome of run.actions) {
        yield* guard(selection.actions.some((step) => step.id === outcome.stepId && same(step.action, outcome.action)))
        if (outcome.kind !== "planned") yield* guard(attempts.some((value) => value.kind === "action" && value.status === "completed" && same(value.outcome, outcome)))
      }
      const state = run.state
      if (state.kind === "succeeded") yield* guard(run.actions.every((outcome) => outcome.kind === "succeeded" || outcome.kind === "skipped") && attempts.some((value) => value.kind === "job" && value.status === "completed" && Object.hasOwn(value.completion, "result") && same(value.completion.result, state.result)))
      if (state.kind === "failed") yield* guard(attempts.some((value) => value.status === "completed" && (value.kind === "job" ? same(value.completion.error, state.error) : value.kind === "decision" ? same(value.error, state.error) : value.outcome.kind === "failed" && same(value.outcome.error, state.error))))
      if (state.kind === "unresolved") yield* guard(run.decision?.kind === "abstained" && run.decision.reason === state.reason)
      return { run, job, currentRun: currentRun!, currentJob: currentJob! }
    })
    const writeSummary = Effect.fn(function*(scope: PersonalScope, summary: Summary) {
      const { run, job } = yield* validateSummary(scope, summary, true)
      yield* sql`UPDATE automation_runs SET json=${encodeJson(run)}, state=${run.state.kind}, version=version+1 WHERE owner_id=${scope.ownerId} AND project_id=${scope.projectId} AND id=${run.id} AND version=${summary.expectedRunVersion}`
      yield* sql`UPDATE automation_jobs SET json=${encodeJson(job)}, state=${job.state.kind}, version=version+1 WHERE owner_id=${scope.ownerId} AND project_id=${scope.projectId} AND id=${job.id} AND version=${summary.expectedJobVersion}`
    })
    const recordAttempt = (scope: PersonalScope, input: Attempt, summary?: Summary) => protectStorage(sql.withTransaction(Effect.gen(function* () {
      yield* decode(PersonalScope, scope)
      const attempt = yield* validateAttempt(scope, input)
      const table = sql(`automation_${attempt.kind}_attempts`)
      const rows = yield* sql<AttemptRow>`SELECT * FROM ${table} WHERE owner_id=${scope.ownerId} AND project_id=${scope.projectId} AND id=${attempt.id}`
      if (rows[0]) {
        const existing = yield* readJson(Attempt, rows[0].json).pipe(Effect.flatMap((value) => validateAttempt(scope, value)))
        yield* guard(rows[0].run_id === existing.runId && rows[0].job_id === existing.jobId && rows[0].step_id === existing.stepId && rows[0].attempt === existing.attempt && rows[0].status === existing.status)
        if (same(existing, attempt) || attempt.status === "started" && same(attemptStart(existing), attempt)) {
          if (summary) { const current = yield* validateSummary(scope, summary, false); yield* guard(same(current.run, current.currentRun.value) && same(current.job, current.currentJob.value), "conflict") }
          return
        }
        yield* guard(existing.status === "started" && attempt.status === "completed" && same(attemptStart(existing), attemptStart(attempt)), "conflict")
        const currentRun = yield* getRun(scope, attempt.runId); yield* guard(currentRun !== null && !isTerminal(currentRun.value), "conflict")
        yield* sql`UPDATE ${table} SET json=${encodeJson(attempt)}, status='completed' WHERE owner_id=${scope.ownerId} AND project_id=${scope.projectId} AND id=${attempt.id} AND status='started'`
      } else {
        yield* guard(attempt.status === "started")
        const currentRun = yield* getRun(scope, attempt.runId); yield* guard(currentRun !== null && !isTerminal(currentRun.value), "conflict")
        yield* sql`INSERT INTO ${table} ${sql.insert({ owner_id: scope.ownerId, project_id: scope.projectId, id: attempt.id, run_id: attempt.runId, job_id: attempt.jobId, step_id: attempt.stepId, attempt: attempt.attempt, status: attempt.status, json: encodeJson(attempt) })}`
      }
      if (summary) { yield* guard(summary.run.id === attempt.runId && summary.job.id === attempt.jobId && attempt.status === "completed"); yield* writeSummary(scope, summary) }
    })))
    const update = (scope: PersonalScope, summary: Summary) => protectStorage(sql.withTransaction(writeSummary(scope, summary)))
    const history = (scope: PersonalScope, id: string) => protectStorage(sql.withTransaction(Effect.gen(function* () {
      const run = yield* getRun(scope, id)
      if (!run) return null
      const rows = yield* sql<{ job_id: string }>`SELECT job_id FROM automation_runs WHERE owner_id=${scope.ownerId} AND project_id=${scope.projectId} AND id=${id}`
      const job = yield* getJob(scope, rows[0]!.job_id); yield* guard(job !== null, "missing")
      return { run, job: job!, attempts: yield* readAttempts(scope, id) }
    })))
    const replay = (scope: PersonalScope, deliveryId: string, key: string, target: Target) => protectStorage(sql.withTransaction(Effect.gen(function* () {
      yield* scopeId(scope, deliveryId); yield* decode(LocalId, key); yield* guard(key !== "initial")
      const delivery = yield* getDelivery(scope, deliveryId); yield* guard(delivery !== null, "missing")
      const existing = yield* originalIds(scope, deliveryId, key)
      if (existing.jobIds.length > 0) return existing
      yield* insertTarget(delivery!.value, target, key)
      return yield* originalIds(scope, deliveryId, key)
    })))
    const list = Effect.fn(function*(scope: PersonalScope, input: Query, table: "runs" | "jobs") {
      yield* decode(PersonalScope, scope); const query = yield* decode(QuerySchema, input)
      const { cursor, ...filter } = query; const filterKey = canonical(filter); let after = 0
      if (cursor) {
        const value = yield* readJson(CursorSchema, cursor)
        yield* guard(same(value.scope, scope) && value.table === table && value.filter === filterKey)
        after = value.after
      }
      const rows = yield* sql<{ id: string; seq: number }>`SELECT id, seq FROM ${sql(`automation_${table}`)} WHERE owner_id=${scope.ownerId} AND project_id=${scope.projectId} AND seq>${after}
        AND (${query.routineId ?? null} IS NULL OR routine_id=${query.routineId ?? null}) AND (${query.deliveryId ?? null} IS NULL OR delivery_id=${query.deliveryId ?? null})
        AND (${query.mode ?? null} IS NULL OR mode=${query.mode ?? null}) AND (${query.state ?? null} IS NULL OR state=${query.state ?? null}) ORDER BY seq LIMIT ${query.limit + 1}`
      const items: Array<RecordVersion<AutomationRun> | RecordVersion<Job>> = []
      for (const row of rows.slice(0, query.limit)) { const value = yield* (table === "runs" ? getRun(scope, row.id) : getJob(scope, row.id)); yield* guard(value !== null, "missing"); items.push(value!) }
      return { items, cursor: rows.length > query.limit ? encodeJson({ schemaVersion: 1, scope, table, filter: filterKey, after: items[items.length - 1]!.sequence }) : null }
    })
    return { ingest, recordAttempt, update, replay, history,
      getDelivery: (scope, id) => protectStorage(sql.withTransaction(getDelivery(scope, id))), getRun: (scope, id) => protectStorage(sql.withTransaction(getRun(scope, id))), getJob: (scope, id) => protectStorage(sql.withTransaction(getJob(scope, id))),
      listRuns: (scope, query) => protectStorage(sql.withTransaction(list(scope, query, "runs"))).pipe(Effect.map((page) => page as Page<RecordVersion<AutomationRun>>)),
      listJobs: (scope, query) => protectStorage(sql.withTransaction(list(scope, query, "jobs"))).pipe(Effect.map((page) => page as Page<RecordVersion<Job>>)) }


  })
}) {}
export const ExecutionRepositoryLayer = Layer.effect(ExecutionRepository, ExecutionRepository.make)

interface DeliveryRow { readonly id: string; readonly seq: number; readonly integration_id: string; readonly external_id: string; readonly raw: Uint8Array; readonly json: string }
interface ExecutionRow { readonly id: string; readonly seq: number; readonly job_id: string; readonly delivery_id: string; readonly routine_id: string; readonly revision: number; readonly mode: string; readonly state: string; readonly version: number; readonly json: string }

interface AttemptRow { readonly id: string; readonly run_id: string; readonly job_id: string; readonly step_id: string; readonly attempt: number; readonly status: string; readonly json: string }
const QuerySchema = Schema.Struct({ limit: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(100)), cursor: Schema.optional(Schema.String), routineId: Schema.optional(LocalId), deliveryId: Schema.optional(LocalId), mode: Schema.optional(Schema.Literals(["preview", "live"])), state: Schema.optional(Schema.Literals(["queued", "running", "succeeded", "unresolved", "failed", "cancelled"])) })
const CursorSchema = Schema.Struct({ schemaVersion: Schema.Literal(1), scope: PersonalScope, table: Schema.Literals(["runs", "jobs"]), filter: Schema.String, after: PositiveVersion })
function immutableRun(run: AutomationRun) { const { state: _state, actions: _actions, decision: _decision, ...value } = run; return value }
function immutableJob(job: Job) { const { state: _state, metadata: _metadata, ...value } = job; return value }
function isTerminal(run: AutomationRun) { return !["queued", "running"].includes(run.state.kind) }
function attemptStart(attempt: Attempt) { const { status: _status, completion: _completion, finishedAt: _finishedAt, result: _result, error: _error, outcome: _outcome, ...value } = attempt as Attempt & { completion?: unknown; finishedAt?: unknown; result?: unknown; error?: unknown; outcome?: unknown }; return { ...value, status: "started" } }
