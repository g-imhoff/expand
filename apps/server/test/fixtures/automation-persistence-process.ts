import { writeFileSync } from "node:fs"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { NodeServices } from "@effect/platform-node"
import { SqlClient } from "effect/sql/SqlClient"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { DatabaseReadyLayer } from "../../migrations/sqlite.js"
import { ConfigurationRepository, ConfigurationRepositoryLayer } from "../../automation/configuration-repository.js"
import { ExecutionRepository, ExecutionRepositoryLayer } from "../../automation/execution-repository.js"
import { configuration, delivery, integration, raw, run, scope, attemptValues, startOf, finalJob, finalRun } from "./automation-persistence-fixture.js"

const [mode, filename, checkpoint] = process.argv.slice(2)
if (!filename) throw new Error("Missing filename")
const Sql = SqliteClient.layer({ filename })
const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(Sql))
const Config = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(Ready))
const Repositories = ExecutionRepositoryLayer.pipe(Layer.provideMerge(Config))
const diagnostic = <A, E>(exit: Exit.Exit<A, E>) => Exit.isSuccess(exit) ? { accepted: true, value: exit.value } : { accepted: false, failure: Cause.squash(exit.cause) }
const program = Effect.gen(function* () {
  const sql = yield* SqlClient
  const config = yield* ConfigurationRepository
  const repository = yield* ExecutionRepository
  if (mode !== "inspect") {
    yield* config.putIntegration(scope, integration, 0)
    yield* config.appendRoutineRevision(configuration, 0, "enabled")
    yield* sql`INSERT OR IGNORE INTO events ${sql.insert({ seq: 1, stream_id: "sentinel", event_type: "fixture", event_revision: 1, payload: '{"original":"é"}', created_at: "t0" })}`
  }
  if (mode === "control") return { pid: process.pid, control: true }
  if (mode === "request-ingest" || mode === "precommit" || mode === "postcommit") {
    let client = sql
    if (mode === "precommit" || mode === "postcommit") {
      client = new Proxy(sql, { get(target, key) {
        if (key !== "withTransaction") return Reflect.get(target, key)
        return <A, E, R>(effect: Effect.Effect<A, E, R>) => {
          const pause = Effect.sync(() => writeFileSync(checkpoint!, Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))({ mode, pid: process.pid, stage: mode === "precommit" ? "before-commit" : "committed-before-response" }))).pipe(Effect.andThen(Effect.never))
          return mode === "precommit" ? target.withTransaction(effect.pipe(Effect.tap(() => pause))) : target.withTransaction(effect).pipe(Effect.tap(() => pause))
        }
      } })
    }
    const active = mode === "request-ingest" ? repository : yield* ExecutionRepository.make.pipe(Effect.provideService(SqlClient, client))
    const exit = yield* Effect.exit(active.ingest({ delivery, raw, targets: [{ jobId: "job", run }] }))
    return { pid: process.pid, ingestion: diagnostic(exit) }
  }
  if (mode === "request-history") {
    const ingestion = yield* Effect.exit(repository.ingest({ delivery, raw, targets: [{ jobId: "job", run }] }))
    const attempts = []
    for (const value of attemptValues) {
      const start = yield* Effect.exit(repository.recordAttempt(scope, startOf(value)))
      attempts.push({ id: value.id, stage: "start", result: diagnostic(start) })
      if (value.status === "completed") {
        const summary = value.id === "action-2" ? { expectedRunVersion: 1, expectedJobVersion: 1, run: finalRun, job: finalJob } : undefined
        const exit = yield* Effect.exit(repository.recordAttempt(scope, value, summary))
        attempts.push({ id: value.id, stage: "finish", result: diagnostic(exit) })
      }
    }
    yield* config.putIntegration(scope, { ...integration, configuration: { mailbox: "changed" } }, 1)
    yield* config.appendRoutineRevision({ ...configuration, reference: { ...configuration.reference, revision: 2 }, configuration: { prefix: "changed" } }, 1, "paused")
    yield* config.setStatus(scope, configuration.reference.routineId, "deleted", 2)
    return { pid: process.pid, ingestion: diagnostic(ingestion), attempts }
  }
  if (mode === "inspect") {
    const pragma = yield* sql`PRAGMA journal_mode`
    const fk = yield* sql`PRAGMA foreign_keys`
    const tables = yield* sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'automation_%'`
    const legacy = yield* sql`SELECT * FROM events WHERE stream_id='sentinel'`
    const revisions = yield* config.getRevision(scope, "routine", 1)
    const deliveries = yield* sql<{ json: string; raw: Uint8Array }>`SELECT json, raw FROM automation_deliveries WHERE owner_id=${scope.ownerId} AND project_id=${scope.projectId}`
    const jobs = yield* sql`SELECT json, version FROM automation_jobs WHERE owner_id=${scope.ownerId} AND project_id=${scope.projectId}`
    const runs = yield* sql`SELECT json, version FROM automation_runs WHERE owner_id=${scope.ownerId} AND project_id=${scope.projectId}`
    const attempts = []
    for (const kind of ["job", "decision", "action"]) {
      const rows = yield* sql<{ json: string }>`SELECT json FROM ${sql(`automation_${kind}_attempts`)} WHERE owner_id=${scope.ownerId} AND project_id=${scope.projectId} ORDER BY seq`
      attempts.push(...rows.map((row) => Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(row.json)))
    }
    return { pid: process.pid, pragma, fk, tables, legacy, revisions, deliveries: deliveries.map((row) => ({ value: Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(row.json), raw: [...row.raw] })), jobs: jobs.map((row) => ({ value: Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(row["json"] as string), version: row["version"] })), runs: runs.map((row) => ({ value: Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(row["json"] as string), version: row["version"] })), attempts, repositoryDelivery: diagnostic(yield* Effect.exit(repository.getDelivery(scope, delivery.id))), repositoryHistory: diagnostic(yield* Effect.exit(repository.history(scope, run.id))) }
  }
  throw new Error("Unknown mode")
}).pipe(Effect.provide(Repositories.pipe(Layer.provideMerge(NodeServices.layer))))
const result = await Effect.runPromise(program)
process.stdout.write(Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(result) + "\n")
