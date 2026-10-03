import { spawn } from "node:child_process"
import { writeFileSync } from "node:fs"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Clock, Deferred, Effect, Schema } from "effect"
import { configuration, delivery, raw, run, attemptValues, finalRun, finalJob } from "../fixtures/automation-persistence-fixture.js"

interface Observation {
  pid: number; pragma: unknown; fk: unknown; tables: unknown[]; legacy: { payload: string; event_revision: number; seq: number }[]; revisions: unknown
  ingestion?: { accepted: boolean; value?: unknown; failure?: unknown }; deliveries: unknown[]; jobs: unknown[]; runs: unknown[]; attempts: unknown[]
  repositoryDelivery: { accepted: boolean }; repositoryHistory: { accepted: boolean; value?: unknown }
}
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const parse = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))
const child = Effect.fn(function*(mode: string, filename: string, checkpoint?: string) {
  const argv = ["--import", "tsx", "apps/server/test/fixtures/automation-persistence-process.ts", mode, filename, ...(checkpoint ? [checkpoint] : [])]
  const startedAt = yield* Clock.currentTimeMillis
  const process = spawn(globalThis.process.execPath, argv, { cwd: globalThis.process.cwd(), env: globalThis.process.env, stdio: ["ignore", "pipe", "pipe"] })
  let stdout = ""; let stderr = ""
  process.stdout.on("data", (data) => { stdout += data.toString() }); process.stderr.on("data", (data) => { stderr += data.toString() })
  const runSync = Effect.runSyncWith(yield* Effect.context<never>())
  const latch = yield* Deferred.make<{ code: number | null; signal: string | null; value: Observation }, Error>()
  process.on("error", (error) => runSync(Deferred.fail(latch, error)))
  process.on("close", (code, signal) => {
    const receipt = { argv: [globalThis.process.execPath, ...argv], cwd: globalThis.process.cwd(), filename, startedAt, endedAt: runSync(Clock.currentTimeMillis), pid: process.pid, code, signal, stdout, stderr }
    writeFileSync(join(globalThis.process.env["T02_RECEIPT_DIR"] ?? tmpdir(), `automation-child-${process.pid}.json`), encode(receipt), { flag: "wx" })
    runSync(Deferred.succeed(latch, { code, signal, value: stdout.trim() ? parse(stdout) as Observation : {} as Observation }))
  })
  yield* Effect.addFinalizer(() => Effect.sync(() => { if (process.exitCode === null && process.signalCode === null) process.kill("SIGKILL") }))
  return { process, done: Deferred.await(latch) }
})
const database = Effect.tryPromise(() => mkdtemp(join(tmpdir(), "automation-restart-"))).pipe(Effect.map((dir) => join(dir, "state.sqlite")))
const controls = (reader: Observation) => {
  expect(reader.pragma).toEqual([{ journal_mode: "wal" }]); expect(reader.fk).toEqual([{ foreign_keys: 1 }]); expect(reader.tables).toHaveLength(11)
  expect(reader.legacy).toMatchObject([{ seq: 1, event_revision: 1, payload: '{"original":"é"}' }]); expect(reader.revisions).toEqual(configuration)
}
const inspected = Effect.fn(function*(filename: string) { const read = yield* (yield* child("inspect", filename)).done; expect(read.code).toBe(0); expect(read.signal).toBeNull(); controls(read.value); return read.value })

describe("automation durability", () => {
  it.live("native controls reopen real schema/configuration/legacy rows", () => Effect.gen(function* () {
    const filename = yield* database; const write = yield* (yield* child("control", filename)).done; expect(write.code).toBe(0)
    const reader = yield* inspected(filename); expect(reader.pid).not.toBe(write.value.pid)
  }).pipe(Effect.scoped))
  it.live("R-ingest retains exact committed original rows in a different native process", () => Effect.gen(function* () {
    const filename = yield* database; const write = yield* (yield* child("request-ingest", filename)).done; expect(write.code).toBe(0); expect(write.signal).toBeNull()
    const reader = yield* inspected(filename); expect(reader.pid).not.toBe(write.value.pid)
    expect.soft(reader.deliveries).toEqual([{ value: delivery, raw: [...raw] }])
    expect.soft(reader.jobs).toHaveLength(1); expect.soft(reader.runs).toEqual([{ value: run, version: 1 }])
    expect.soft(reader.repositoryDelivery.accepted).toBe(true)
    expect.soft(write.value.ingestion).toEqual({ accepted: true, value: { deliveryId: "input", jobIds: ["job"], runIds: ["run"] } })
  }).pipe(Effect.scoped))
  it.live("R-history retains supplied failures/results and unfinished start after edited/deleted heads", () => Effect.gen(function* () {
    const filename = yield* database; const write = yield* (yield* child("request-history", filename)).done; expect(write.code).toBe(0); expect(write.signal).toBeNull()
    const reader = yield* inspected(filename); expect(reader.pid).not.toBe(write.value.pid)
    expect(reader.deliveries).toEqual([{ value: delivery, raw: [...raw] }]); expect(write.value.ingestion?.accepted).toBe(true)
    expect.soft(reader.attempts).toEqual(attemptValues)
    expect.soft(reader.runs).toEqual([{ value: finalRun, version: 2 }]); expect.soft(reader.jobs).toEqual([{ value: finalJob, version: 2 }])
    expect.soft(reader.repositoryHistory.accepted).toBe(true)
    expect.soft(reader.repositoryHistory.value).toMatchObject({ run: { value: finalRun, version: 2 }, job: { value: finalJob, version: 2 }, attempts: attemptValues })
  }).pipe(Effect.scoped))
  for (const mode of ["precommit", "postcommit"]) it.live(`${mode} SIGKILL preserves real transaction boundary and retry`, () => Effect.gen(function* () {
    const filename = yield* database; yield* (yield* child("control", filename)).done
    const checkpoint = filename + ".checkpoint"; const write = yield* child(mode, filename, checkpoint)
    const expected = { mode, pid: write.process.pid, stage: mode === "precommit" ? "before-commit" : "committed-before-response" }
    const deadline = (yield* Clock.currentTimeMillis) + 10_000; let observed: unknown
    while ((yield* Clock.currentTimeMillis) < deadline) {
      const text = yield* Effect.tryPromise(() => readFile(checkpoint, "utf8")).pipe(Effect.orElseSucceed(() => ""))
      observed = yield* Effect.try(() => parse(text)).pipe(Effect.orElseSucceed(() => null))
      if (encode(observed) === encode(expected)) break
      yield* Effect.sleep("20 millis")
    }
    expect(observed).toEqual(expected); expect(write.process.kill("SIGKILL")).toBe(true)
    const death = yield* write.done; expect(death.signal).toBe("SIGKILL"); expect(death.code).toBeNull(); expect(death.value).toEqual({})
    const reader = yield* inspected(filename); expect(reader.deliveries).toHaveLength(mode === "precommit" ? 0 : 1); expect(reader.jobs).toHaveLength(mode === "precommit" ? 0 : 1); expect(reader.runs).toHaveLength(mode === "precommit" ? 0 : 1)
    const retry = yield* (yield* child("request-ingest", filename)).done; expect(retry.value.ingestion).toEqual({ accepted: true, value: { deliveryId: "input", jobIds: ["job"], runIds: ["run"] } })
    const recovered = yield* inspected(filename); expect(recovered.deliveries).toEqual([{ value: delivery, raw: [...raw] }]); expect(recovered.jobs).toHaveLength(1); expect(recovered.runs).toEqual([{ value: run, version: 1 }])
  }).pipe(Effect.scoped))
  it.live("bounded independent writers recover the same scoped duplicate", () => Effect.gen(function* () {
    const filename = yield* database; yield* (yield* child("control", filename)).done
    const children = yield* Effect.forEach(Array.from({ length: 3 }, () => "request-ingest"), (mode) => child(mode, filename))
    const writers = yield* Effect.all(children.map((process) => process.done), { concurrency: "unbounded" })
    expect(new Set(writers.map((writer) => writer.value.pid)).size).toBe(3)
    for (const writer of writers) { expect(writer.code).toBe(0); expect(writer.value.ingestion).toEqual({ accepted: true, value: { deliveryId: "input", jobIds: ["job"], runIds: ["run"] } }) }
    const reader = yield* inspected(filename); expect(reader.jobs).toHaveLength(1); expect(reader.runs).toHaveLength(1)
  }).pipe(Effect.scoped))
})
