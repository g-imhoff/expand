import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Cause, Clock, Config as EffectConfig, Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { SqlClient } from "effect/sql/SqlClient"
import { DatabaseReadyLayer } from "../../migrations/sqlite.js"
import { ConfigurationRepository, ConfigurationRepositoryLayer } from "../../automation/configuration-repository.js"
import { ExecutionRepository, ExecutionRepositoryLayer } from "../../automation/execution-repository.js"
import { StorageError, type Attempt } from "../../automation/persistence-models.js"
import { configuration, integration, scope, delivery, raw, run, attemptValues, startOf, finalRun, finalJob, baseJob, failure, decisionResult, action } from "../fixtures/automation-persistence-fixture.js"

const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
const Config = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(Ready))
const Repositories = ExecutionRepositoryLayer.pipe(Layer.provideMerge(Config))
const seed = Effect.gen(function* () { const config = yield* ConfigurationRepository; yield* config.putIntegration(scope, integration, 0); yield* config.appendRoutineRevision(configuration, 0, "enabled") })
const input = { delivery, raw, targets: [{ jobId: "job", run }] }
const counts = Effect.gen(function* () { const sql = yield* SqlClient; return yield* sql`SELECT (SELECT count(*) FROM automation_deliveries) deliveries, (SELECT count(*) FROM automation_jobs) jobs, (SELECT count(*) FROM automation_runs) runs` })

describe("execution repository", () => {
  it.live("commits exact evidence and deduplicates concurrent shared-client requests and changed targets", () => Effect.gen(function* () {
    yield* seed; const repository = yield* ExecutionRepository; const config = yield* ConfigurationRepository
    const accepted = yield* Effect.all(Array.from({ length: 5 }, () => repository.ingest(input)), { concurrency: "unbounded" })
    expect(accepted).toEqual(Array.from({ length: 5 }, () => ({ deliveryId: "input", jobIds: ["job"], runIds: ["run"] })))
    expect(yield* counts).toEqual([{ deliveries: 1, jobs: 1, runs: 1 }])
    expect((yield* repository.getJob(scope, "job"))?.value).toEqual(baseJob)
    expect((yield* repository.getDelivery(scope, "input"))?.raw).toEqual(raw)
    yield* config.appendRoutineRevision({ ...configuration, reference: { ...configuration.reference, revision: 2 }, configuration: { edited: true } }, 1, "paused")
    const changed = { ...run, id: "new-run", configuration: { ...run.configuration, revision: 2 }, authority: { ...run.authority, configuration: { ...run.configuration, revision: 2 } } }
    expect(yield* repository.ingest({ ...input, targets: [{ jobId: "new-job", run: changed }] })).toEqual(accepted[0])
    expect(yield* counts).toEqual([{ deliveries: 1, jobs: 1, runs: 1 }])
    for (const conflict of [{ ...input, raw: new Uint8Array([1]) }, { ...input, delivery: { ...delivery, payload: { changed: true } } }, { ...input, delivery: { ...delivery, trigger: { ...delivery.trigger, version: 2 } } }]) expect(Exit.isFailure(yield* Effect.exit(repository.ingest(conflict)))).toBe(true)
    expect(yield* counts).toEqual([{ deliveries: 1, jobs: 1, runs: 1 }])
  }).pipe(Effect.provide(Repositories)))
  it.live("rejects one invalid target and rolls back an actual later DML failure", () => Effect.gen(function* () {
    yield* seed; const repository = yield* ExecutionRepository; const sql = yield* SqlClient
    const invalid = { ...run, id: "other-run", input: { ...run.input, id: "missing" } }
    expect(Exit.isFailure(yield* Effect.exit(repository.ingest({ ...input, targets: [...input.targets, { jobId: "other-job", run: invalid }] })))).toBe(true)
    expect(yield* counts).toEqual([{ deliveries: 0, jobs: 0, runs: 0 }])
    yield* sql`CREATE TRIGGER reject_run BEFORE INSERT ON automation_runs BEGIN SELECT RAISE(ABORT, 'owned fixture'); END`
    expect(Exit.isFailure(yield* Effect.exit(repository.ingest(input)))).toBe(true)
    expect(yield* counts).toEqual([{ deliveries: 0, jobs: 0, runs: 0 }])
    yield* sql`DROP TRIGGER reject_run`
    yield* repository.ingest(input)
    expect(yield* counts).toEqual([{ deliveries: 1, jobs: 1, runs: 1 }])
  }).pipe(Effect.provide(Repositories)))
})

describe("history persistence", () => {
  it.live("retains actual attempts, exact replay and rejects immutable/cross-linked evidence", () => Effect.gen(function* () {
    yield* seed; const repository = yield* ExecutionRepository; yield* repository.ingest(input)
    for (const value of attemptValues) {
      yield* repository.recordAttempt(scope, startOf(value))
      if (value.status === "completed") yield* repository.recordAttempt(scope, value, value.id === "action-2" ? { expectedRunVersion: 1, expectedJobVersion: 1, run: finalRun, job: finalJob } : undefined)
    }
    expect((yield* repository.history(scope, "run"))?.run.value.decision).toEqual(decisionResult)
    expect((yield* repository.history(scope, "run"))?.attempts).toEqual(attemptValues)
    for (const value of attemptValues) yield* repository.recordAttempt(scope, value)
    yield* repository.recordAttempt(scope, attemptValues[5]!, { expectedRunVersion: 1, expectedJobVersion: 1, run: finalRun, job: finalJob })
    expect((yield* repository.getRun(scope, "run"))?.version).toBe(2)
    for (const invalid of [
      { ...(attemptValues[0]! as Extract<Attempt, { kind: "job"; status: "completed" }>), request: { changed: true } },
      { ...startOf(attemptValues[2]!), id: "bad-decision", attempt: 3, request: { ...((attemptValues[2]! as Extract<typeof attemptValues[number], { kind: "decision" }>).request), input: { kind: "input-reference" as const, id: "other" } } },
      { ...startOf(attemptValues[4]!), id: "bad-action", attempt: 4, stepId: "missing" },
      { ...startOf(attemptValues[4]!), id: "bad-link", attempt: 4, jobId: "missing" },
      { ...startOf(attemptValues[4]!), id: "bad-scope", attempt: 4, scope: { ...scope, ownerId: "other" } }
    ]) expect(Exit.isFailure(yield* Effect.exit(repository.recordAttempt(scope, invalid)))).toBe(true)
    expect((yield* repository.history(scope, "run"))?.attempts).toEqual(attemptValues)
    expect(Exit.isFailure(yield* Effect.exit(repository.update(scope, { expectedRunVersion: 1, expectedJobVersion: 1, run: finalRun, job: finalJob })))).toBe(true)
    expect(Exit.isFailure(yield* Effect.exit(repository.update(scope, { expectedRunVersion: 2, expectedJobVersion: 2, run: { ...finalRun, state: { kind: "succeeded", result: "invented" } }, job: { ...finalJob, state: { kind: "succeeded", result: "invented" } } })))).toBe(true)
  }).pipe(Effect.provide(Repositories)))
  it.live("requires real starts and atomically rolls back completion plus CAS summary on later SQL error", () => Effect.gen(function* () {
    yield* seed; const repository = yield* ExecutionRepository; const sql = yield* SqlClient; yield* repository.ingest(input)
    expect(Exit.isFailure(yield* Effect.exit(repository.recordAttempt(scope, attemptValues[5]!)))).toBe(true)
    for (const value of attemptValues.slice(0, 6)) { yield* repository.recordAttempt(scope, startOf(value)); if (value.id !== "action-2") yield* repository.recordAttempt(scope, value) }
    const summary = { expectedRunVersion: 1, expectedJobVersion: 1, run: finalRun, job: finalJob }
    yield* sql`CREATE TRIGGER reject_summary BEFORE UPDATE ON automation_runs BEGIN SELECT RAISE(ABORT, 'owned summary fixture'); END`
    expect(Exit.isFailure(yield* Effect.exit(repository.recordAttempt(scope, attemptValues[5]!, summary)))).toBe(true)
    const before = yield* repository.history(scope, "run")
    expect(before?.run.version).toBe(1); expect(before?.job.version).toBe(1); expect(before?.attempts.find((value) => value.id === "action-2")?.status).toBe("started")
    yield* sql`DROP TRIGGER reject_summary`
    yield* repository.recordAttempt(scope, attemptValues[5]!, summary)
    expect((yield* repository.history(scope, "run"))?.run.value).toEqual(finalRun)
  }).pipe(Effect.provide(Repositories)))
  it.live("stores explicit six states, preserves terminal states and planned versus actual outcomes", () => Effect.gen(function* () {
    yield* seed; const repository = yield* ExecutionRepository
    for (const kind of ["queued", "running", "succeeded", "unresolved", "failed", "cancelled"] as const) {
      const id = kind; const value = { ...run, id, input: { ...run.input, id } }
      yield* repository.ingest({ delivery: { ...delivery, id, externalId: id }, raw, targets: [{ jobId: id, run: value }] })
      const job = (yield* repository.getJob(scope, id))!.value
      const state = kind === "queued" || kind === "running" ? { kind } : kind === "succeeded" ? { kind, result: { done: true } } : kind === "unresolved" ? { kind, reason: "abstained" } : kind === "failed" ? { kind, error: failure } : { kind, reason: "caller cancelled" }
      if (kind === "succeeded" || kind === "failed") {
        const start = { ...startOf(attemptValues[0]!), id: id + "-attempt", jobId: id, runId: id }
        yield* repository.recordAttempt(scope, start)
        const complete = { ...attemptValues[0]!, id: id + "-attempt", jobId: id, runId: id, completion: kind === "succeeded" ? { finishedAt: "t2", result: { done: true } } : { finishedAt: "t2", error: failure } }
        yield* repository.recordAttempt(scope, complete)
      }
      if (kind === "unresolved") {
        const start = { ...startOf(attemptValues[2]!), id: id + "-decision", jobId: id, runId: id, request: { ...((attemptValues[2]! as Extract<typeof attemptValues[number], { kind: "decision" }>).request), input: value.input } }
        yield* repository.recordAttempt(scope, start)
        yield* repository.recordAttempt(scope, { ...start, kind: "decision", status: "completed", finishedAt: "t2", result: { schemaVersion: 1, kind: "abstained", reason: "abstained" } })
      }
      const next = { ...value, state, ...(kind === "unresolved" ? { decision: { schemaVersion: 1 as const, kind: "abstained" as const, reason: "abstained" } } : {}) }
      yield* repository.update(scope, { expectedRunVersion: 1, expectedJobVersion: 1, run: next, job: { ...job, state } })
      expect((yield* repository.getRun(scope, id))?.value.state).toEqual(state)
      if (!["queued", "running"].includes(kind)) expect(Exit.isFailure(yield* Effect.exit(repository.update(scope, { expectedRunVersion: 2, expectedJobVersion: 2, run: { ...next, state: { kind: "running" } }, job: { ...job, state: { kind: "running" } } })))).toBe(true)
    }
  }).pipe(Effect.provide(Repositories)))
  it.live("reads bounded scoped keyset pages, replay original IDs, and rejects corrupt stored rows", () => Effect.gen(function* () {
    yield* seed; const repository = yield* ExecutionRepository; const config = yield* ConfigurationRepository; const sql = yield* SqlClient
    yield* repository.ingest({ ...input, targets: [...input.targets, { jobId: "preview-job", run: { ...run, id: "preview-run", mode: "preview" } }] })
    const first = yield* repository.listRuns(scope, { limit: 1 }); const second = yield* repository.listRuns(scope, { limit: 1, cursor: first.cursor! })
    expect(first.items.map((row) => row.value.id)).toEqual(["run"]); expect(second.items.map((row) => row.value.id)).toEqual(["preview-run"]); expect(second.cursor).toBeNull()
    expect((yield* repository.listJobs(scope, { limit: 10, mode: "preview", routineId: "routine", deliveryId: "input", state: "queued" })).items.map((row) => row.value.id)).toEqual(["preview-job"])
    expect(Exit.isFailure(yield* Effect.exit(repository.listRuns(scope, { limit: 101 })))).toBe(true)
    for (const other of [{ ...scope, ownerId: "other" }, { ...scope, projectId: "other" }]) {
      expect(yield* repository.getRun(other, "run")).toBeNull(); expect((yield* repository.listRuns(other, { limit: 10 })).items).toEqual([])
      expect(Exit.isFailure(yield* Effect.exit(repository.listRuns(other, { limit: 1, cursor: first.cursor! })))).toBe(true)
      yield* config.putIntegration(other, integration, 0); yield* config.appendRoutineRevision({ ...configuration, scope: other }, 0, "enabled")
      const otherRun = { ...run, scope: other, authority: { ...run.authority, scope: other } }
      yield* repository.ingest({ delivery: { ...delivery, scope: other }, raw, targets: [{ jobId: "job", run: otherRun }] })
      expect((yield* repository.getRun(other, "run"))?.value.scope).toEqual(other)
    }
    const replay = yield* repository.replay(scope, "input", "explicit-replay", { jobId: "replay-job", run: { ...run, id: "replay-run" } })
    expect(yield* repository.replay(scope, "input", "explicit-replay", { jobId: "ignored-id", run: { ...run, id: "ignored-run" } })).toEqual(replay)
    expect((yield* repository.listRuns(scope, { limit: 10 })).items).toHaveLength(3)
    yield* sql`UPDATE automation_runs SET state='failed' WHERE owner_id=${scope.ownerId} AND project_id=${scope.projectId} AND id='run'`
    expect(Exit.isFailure(yield* Effect.exit(repository.getRun(scope, "run")))).toBe(true)
    expect(Exit.isFailure(yield* Effect.exit(repository.listRuns(scope, { limit: 10 })))).toBe(true)
  }).pipe(Effect.provide(Repositories)))
})

describe("custom routine evidence", () => {
  it.live("persists caller-planned preview actions, actual skips and independent integration delivery keys", () => Effect.gen(function* () {
    yield* seed; const repository = yield* ExecutionRepository; const config = yield* ConfigurationRepository
    const { template: _template, process: _originalProcess, ...customBase } = configuration
    const { decision: _decision, ...process } = configuration.process
    const custom = { ...customBase, reference: { routineId: "custom", revision: 1 }, process: { ...process, actions: { triggered: [action] } } }
    yield* config.appendRoutineRevision(custom, 0, "enabled")
    expect(yield* config.getRevision(scope, "custom", 1)).toEqual(custom)
    const planned = { kind: "planned" as const, stepId: action.id, action: action.action, arguments: { message: "caller planned", count: "2" } }
    const preview = { ...run, id: "custom-run", mode: "preview" as const, configuration: custom.reference, authority: { ...run.authority, configuration: custom.reference }, actions: [planned] }
    yield* repository.ingest({ ...input, targets: [{ jobId: "custom-job", run: preview }] })
    expect((yield* repository.getRun(scope, preview.id))?.value.actions).toEqual([planned])
    const start = { ...(startOf(attemptValues[4]!) as Extract<Attempt, { kind: "action"; status: "started" }>), id: "custom-action", runId: preview.id, jobId: "custom-job" }
    yield* repository.recordAttempt(scope, start)
    expect((yield* repository.history(scope, preview.id))?.attempts).toEqual([start])
    const skipped = { kind: "skipped" as const, stepId: action.id, action: action.action, reason: "caller supplied skip" }
    const completed = { ...start, status: "completed" as const, finishedAt: "t2", outcome: skipped }
    const job = (yield* repository.getJob(scope, "custom-job"))!.value
    const next = { ...preview, state: { kind: "running" as const }, actions: [skipped] }
    yield* repository.recordAttempt(scope, completed, { expectedRunVersion: 1, expectedJobVersion: 1, run: next, job: { ...job, state: next.state } })
    expect((yield* repository.history(scope, preview.id))?.attempts).toEqual([completed])
    expect((yield* repository.getRun(scope, preview.id))?.value).toEqual(next)
    const second = { ...integration, id: "second-mail" }; const reference = { id: second.id, definition: second.definition }
    yield* config.putIntegration(scope, second, 0)
    const secondConfig = { ...custom, reference: { routineId: "second-custom", revision: 1 }, integrations: [second], process: { ...custom.process, trigger: { ...custom.process.trigger, integration: reference }, actions: { triggered: [{ ...action, integration: reference }] } } }
    yield* config.appendRoutineRevision(secondConfig, 0, "enabled")
    const secondRun = { ...run, id: "second-run", configuration: secondConfig.reference, input: { ...run.input, id: "second-input" }, authority: { ...run.authority, configuration: secondConfig.reference, integrationIds: [second.id], actionGrants: run.authority.actionGrants.map((grant) => ({ ...grant, integrationId: second.id })) } }
    const accepted = yield* repository.ingest({ delivery: { ...delivery, id: "second-input", integration: reference }, raw, targets: [{ jobId: "second-job", run: secondRun }] })
    expect(accepted).toEqual({ deliveryId: "second-input", jobIds: ["second-job"], runIds: ["second-run"] })
    expect(yield* counts).toEqual([{ deliveries: 2, jobs: 2, runs: 2 }])
  }).pipe(Effect.provide(Repositories)))
})
describe("commit outcomes", () => {
  it.live("returns typed errors for rolled-back and postcommit unknown outcomes without invented acknowledgement", () => Effect.gen(function* () {
    yield* seed; const sql = yield* SqlClient; const repository = yield* ExecutionRepository
    const fail = Effect.fail(new StorageError({ code: "storage", message: "Owned commit boundary failure" }))
    for (const committed of [false, true]) {
      const client = new Proxy(sql, { get(target, key) { if (key !== "withTransaction") return Reflect.get(target, key); return <A, E, R>(effect: Effect.Effect<A, E, R>) => committed ? target.withTransaction(effect).pipe(Effect.andThen(fail)) : target.withTransaction(effect.pipe(Effect.andThen(fail))) } })
      const controlled = yield* ExecutionRepository.make.pipe(Effect.provideService(SqlClient, client))
      expect(Exit.isFailure(yield* Effect.exit(controlled.ingest(input)))).toBe(true)
      expect(yield* counts).toEqual([{ deliveries: committed ? 1 : 0, jobs: committed ? 1 : 0, runs: committed ? 1 : 0 }])
    }
    expect(yield* repository.ingest(input)).toEqual({ deliveryId: "input", jobIds: ["job"], runIds: ["run"] })
    expect(yield* counts).toEqual([{ deliveries: 1, jobs: 1, runs: 1 }])
  }).pipe(Effect.provide(Repositories)))
})

describe("history snapshot", () => {
  it.live("keeps state and attempts in one real transaction during a competing CAS completion", () => Effect.gen(function* () {
    yield* seed; const repository = yield* ExecutionRepository; const sql = yield* SqlClient; yield* repository.ingest(input)
    for (const value of attemptValues.slice(0, 6)) { yield* repository.recordAttempt(scope, startOf(value)); if (value.id !== "action-2") yield* repository.recordAttempt(scope, value) }
    const reached = yield* Deferred.make<void>(); const release = yield* Deferred.make<void>(); const writerStarted = yield* Deferred.make<void>()
    let pause = true
    const controlledSql = new Proxy(sql, { apply(target, receiver, args) {
      const statement = Reflect.apply(target, receiver, args) as import("effect/sql/Statement").Statement<Record<string, unknown>>
      if (pause && Array.isArray(args[0]) && args[0].join(" ").includes("SELECT * FROM automation_runs")) {
        pause = false
        return statement.pipe(Effect.tap(() => Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(release)))))
      }
      return statement
    } })
    const controlled = yield* ExecutionRepository.make.pipe(Effect.provideService(SqlClient, controlledSql))
    const reader = yield* Effect.forkChild(controlled.history(scope, "run"))
    yield* Deferred.await(reached)
    const writer = yield* Effect.forkChild(Deferred.succeed(writerStarted, undefined).pipe(Effect.andThen(repository.recordAttempt(scope, attemptValues[5]!, { expectedRunVersion: 1, expectedJobVersion: 1, run: finalRun, job: finalJob }))))
    yield* Deferred.await(writerStarted); yield* Effect.yieldNow
    expect(writer.pollUnsafe()).toBeUndefined()
    yield* Deferred.succeed(release, undefined)
    const old = yield* Fiber.join(reader); yield* Fiber.join(writer)
    expect(old?.run.version).toBe(1); expect(old?.attempts.find((value) => value.id === "action-2")?.status).toBe("started")
    const current = yield* repository.history(scope, "run")
    expect(current?.run.version).toBe(2); expect(current?.attempts.find((value) => value.id === "action-2")?.status).toBe("completed")
  }).pipe(Effect.provide(Repositories)))
})

describe("native corruption restart", () => {
  it.live("returns typed corruption after another process reopens original durable history", () => Effect.gen(function* () {
    const filename = join(mkdtempSync(join(tmpdir(), "automation-corrupt-")), "state.sqlite")
    const source = fileURLToPath(new URL("../fixtures/automation-persistence-process.ts", import.meta.url))
    const receiptDirectory = yield* EffectConfig.String("T02_RECEIPT_DIR").pipe(EffectConfig.withDefault(tmpdir()))
    const call = Effect.fn(function*(mode: string) {
      const argv = ["--import", "tsx", source, mode, filename]
      const startedAt = yield* Clock.currentTimeMillis
      const result = spawnSync(process.execPath, argv, { encoding: "utf8" })
      const endedAt = yield* Clock.currentTimeMillis
      const receipt = { argv: [process.execPath, ...argv], cwd: process.cwd(), filename, pid: result.pid, code: result.status, signal: result.signal, startedAt, endedAt, stdout: result.stdout, stderr: result.stderr }
      writeFileSync(join(receiptDirectory, `automation-corruption-child-${result.pid}.json`), Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(receipt), { flag: "wx" })
      expect(result.status).toBe(0); expect(result.signal).toBeNull()
      return Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(result.stdout) as { pid: number; pragma: unknown; fk: unknown; revisions: unknown; repositoryHistory: { accepted: boolean; failure?: { code: string } } }
    })
    const writer = yield* call("request-history")
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient
      yield* sql`UPDATE automation_runs SET json=json_set(json, '$.schemaVersion', 2) WHERE owner_id=${scope.ownerId} AND project_id=${scope.projectId} AND id='run'`
    }).pipe(Effect.provide(SqliteClient.layer({ filename })))
    const reader = yield* call("inspect")
    expect(reader.pid).not.toBe(writer.pid); expect(reader.pragma).toEqual([{ journal_mode: "wal" }]); expect(reader.fk).toEqual([{ foreign_keys: 1 }]); expect(reader.revisions).toEqual(configuration)
    expect(reader.repositoryHistory.accepted).toBe(false); expect(reader.repositoryHistory.failure?.code).toBe("invalid")
  }))
})

describe("native commit failure", () => {
  it.live("rejects a real deferred-FK COMMIT failure with a typed storage error and rolls back inserted work", () => Effect.gen(function* () {
    yield* seed; const sql = yield* SqlClient
    const controlledSql = new Proxy(sql, { get(target, key) {
      if (key !== "withTransaction") return Reflect.get(target, key)
      return <A, E, R>(effect: Effect.Effect<A, E, R>) => target.withTransaction(effect.pipe(Effect.tap(() => sql`INSERT INTO automation_routines ${sql.insert({ owner_id: scope.ownerId, project_id: scope.projectId, id: "commit-probe", head_revision: 99, status: "enabled", version: 1 })}`)))
    } })
    const repository = yield* ExecutionRepository.make.pipe(Effect.provideService(SqlClient, controlledSql))
    const exit = yield* Effect.exit(repository.ingest(input))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect.soft(Cause.squash(exit.cause)).toBeInstanceOf(StorageError)
    expect.soft(yield* counts).toEqual([{ deliveries: 0, jobs: 0, runs: 0 }])
    expect(yield* sql`SELECT count(*) n FROM automation_routines WHERE id='commit-probe'`).toEqual([{ n: 0 }])
  }).pipe(Effect.provide(Repositories)))
})
