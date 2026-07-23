import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Cause, Data, Duration, Effect, Exit, Fiber, FileSystem, Layer, Path, Schedule, Schema, Stream, SubscriptionRef } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { describe, expect } from "vitest"
import { EndpointFromJson } from "@expand/contracts/endpoint"
import { ProjectRenamed } from "@expand/contracts/events/project"
import type { SequencedEvent } from "@expand/contracts/events/domain"
import { ProcessControl } from "@expand/contracts/process-control"
import { ClientSession, type ClientSessionApi, type ConnectionStatus } from "@expand/client-ts"
import { ProcessServices } from "@expand/client-ts/adapters/node"
import { ProjectClient, type ProjectClientApi } from "@expand/client-ts/project"
import { AuditAppendError, AuditLineFromJson, AuditParseError, AuditSessionError, runAuditLog } from "../audit-log"
import { makeDataDir, makeFixtureDir, runExample, spawnExample } from "./helpers"

/** Parse the audit JSONL, tolerating an absent/partial file mid-write. */
const auditLines = (outfile: string) => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  if (!(yield* fs.exists(outfile))) return []
  const text = yield* fs.readFileString(outfile)
  return yield* Effect.forEach(text.trim().split("\n").filter(Boolean), (line) =>
    Schema.decodeUnknownEffect(AuditLineFromJson)(line))
})

const endpointPid = Effect.fn("AuditTest.endpointPid")(function*(dataDir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const endpointFile = path.join(dataDir, "server.json")
  if (!(yield* fs.exists(endpointFile))) return undefined
  return (yield* fs.readFileString(endpointFile).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(EndpointFromJson))
  )).pid
})

const event = (seq: number): SequencedEvent => ({
  seq,
  event: ProjectRenamed.make({
    projectId: "00000000-0000-4000-8000-000000000001",
    name: `name-${seq}`,
    occurredAt: `t${seq}`
  })
})

/** Poll `predicate` until it returns true or `timeoutMs` elapses. */
const PollPending = Data.TaggedError("AuditTestPollPending")

const pollUntil = <E, R>(predicate: Effect.Effect<boolean, E, R>, timeoutMs: number, stepMs = 100) =>
  predicate.pipe(
    Effect.filterOrFail((matched) => matched, () => new PollPending(undefined)),
    Effect.retry(Schedule.addDelay(
      Schedule.recurs(Math.ceil(timeoutMs / stepMs)),
      () => Effect.succeed(Duration.millis(stepMs))
    )),
    Effect.as(true),
    Effect.catchIf((error) => error instanceof PollPending, () => Effect.succeed(false))
  )

describe("example: audit-log", () => {
  it.effect("fails loudly with a typed error when the output cannot be appended", () =>
    Effect.scoped(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dataDir = yield* fs.makeTempDirectoryScoped({ prefix: "expand-ex-" })
      const outfile = path.join(dataDir, "audit-directory")
      yield* fs.makeDirectory(outfile)
      const status = yield* SubscriptionRef.make<ConnectionStatus>("connected")
      const session: ClientSessionApi = { status, current: Effect.die("unused"), epochs: Stream.empty }
      const client = { events: () => Stream.make(event(1)).pipe(Stream.concat(Stream.never)) } as unknown as ProjectClientApi
      const exit = yield* Effect.exit(runAuditLog(outfile).pipe(
        Effect.provide(Layer.mergeAll(
          Layer.succeed(ClientSession, session),
          Layer.succeed(ProjectClient, client)
        )),
        Effect.timeout("500 millis")
      ))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.findErrorOption(exit.cause).pipe((option) => option._tag === "Some" ? option.value : undefined)).toBeInstanceOf(AuditAppendError)
      }
    })).pipe(Effect.provide(NodeServices.layer)))

  it.effect("reports malformed existing JSONL through the typed parse channel", () =>
    Effect.scoped(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dataDir = yield* fs.makeTempDirectoryScoped({ prefix: "expand-ex-" })
      const outfile = path.join(dataDir, "audit.jsonl")
      yield* fs.writeFileString(outfile, "not-json\n")
      const status = yield* SubscriptionRef.make<ConnectionStatus>("connected")
      const session: ClientSessionApi = { status, current: Effect.die("unused"), epochs: Stream.empty }
      const client = { events: () => Stream.never } as unknown as ProjectClientApi
      const error = yield* runAuditLog(outfile).pipe(
        Effect.provide(Layer.mergeAll(
          Layer.succeed(ClientSession, session),
          Layer.succeed(ProjectClient, client)
        )),
        Effect.flip
      )
      expect(error).toBeInstanceOf(AuditParseError)
    })).pipe(Effect.provide(NodeServices.layer)))

  it.effect("reports event RPC failures through the typed session channel", () =>
    Effect.scoped(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dataDir = yield* fs.makeTempDirectoryScoped({ prefix: "expand-ex-" })
      const status = yield* SubscriptionRef.make<ConnectionStatus>("connected")
      const session: ClientSessionApi = { status, current: Effect.die("unused"), epochs: Stream.empty }
      const client = { events: () => Stream.fail({ reason: "rpc" }) } as unknown as ProjectClientApi
      const error = yield* runAuditLog(path.join(dataDir, "audit.jsonl")).pipe(
        Effect.provide(Layer.mergeAll(
          Layer.succeed(ClientSession, session),
          Layer.succeed(ProjectClient, client)
        )),
        Effect.flip
      )
      expect(error).toBeInstanceOf(AuditSessionError)
    })).pipe(Effect.provide(NodeServices.layer)))

  it.live("reopens Events from the last cursor on a newly connected session epoch", () =>
    Effect.scoped(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dataDir = yield* fs.makeTempDirectoryScoped({ prefix: "expand-ex-" })
      const outfile = path.join(dataDir, "audit.jsonl")
      const status = yield* SubscriptionRef.make<ConnectionStatus>("connected")
      const eventRequests: number[] = []
      let closedEpochs = 0
      const session: ClientSessionApi = { status, current: Effect.die("unused"), epochs: Stream.empty }
      const client = {
        events: ({ fromSeq = 0 } = {}) => {
          eventRequests.push(fromSeq)
          return Stream.make(event(eventRequests.length)).pipe(
            Stream.concat(Stream.never),
            Stream.ensuring(Effect.sync(() => { closedEpochs += 1 }))
          )
        }
      } as unknown as ProjectClientApi
      const fiber = yield* runAuditLog(outfile).pipe(
        Effect.provide(Layer.mergeAll(
          Layer.succeed(ClientSession, session),
          Layer.succeed(ProjectClient, client)
        )),
        Effect.forkChild({ startImmediately: true })
      )
      expect(yield* pollUntil(auditLines(outfile).pipe(Effect.map((lines) => lines.some((line) => line.seq === 1))), 1_000)).toBe(true)
      yield* SubscriptionRef.set(status, "reconnecting")
      expect(yield* pollUntil(Effect.sync(() => closedEpochs === 1), 1_000)).toBe(true)
      yield* SubscriptionRef.set(status, "connected")
      expect(yield* pollUntil(auditLines(outfile).pipe(Effect.map((lines) => lines.some((line) => line.seq === 2))), 1_000)).toBe(true)
      expect(eventRequests).toEqual([0, 1])
      expect((yield* auditLines(outfile)).map((line) => line.seq)).toEqual([1, 2])
      yield* Fiber.interrupt(fiber)
    })).pipe(Effect.provide(NodeServices.layer)))

  it.live("appends a JSONL line for each project change", () =>
    Effect.scoped(Effect.gen(function*() {
      const path = yield* Path.Path
      const dataDir = yield* makeDataDir()
      const outfile = path.join(dataDir, "audit.jsonl")
      const scan = yield* makeFixtureDir(["audited"])
      // Start the long-running audit-log in the background against the shared data dir.
      const audit = yield* spawnExample("audit-log.ts", [outfile], dataDir)
      yield* audit.waitForLine("audit-log: writing to", 30_000)
      // Cause a change on the same backend: bootstrap a project from a throwaway fixture.
      const boot = yield* runExample("bootstrap-projects.ts", [scan], dataDir) // creates project "audited"
      expect(boot.code, boot.stderr).toBe(0)
      // Poll the outfile for the event instead of a flat sleep.
      const seen = yield* pollUntil(auditLines(outfile).pipe(Effect.map((lines) => lines.some((entry) => entry.tag === "ProjectCreated"))), 5_000)
      expect(seen, "expected a ProjectCreated line in the audit log").toBe(true)
    })).pipe(Effect.provide(NodeServices.layer)), 45_000)

  it.live("continues from the last sequence after the backend reconnects", () =>
    Effect.scoped(Effect.gen(function*() {
      const path = yield* Path.Path
      const dataDir = yield* makeDataDir()
      const outfile = path.join(dataDir, "audit.jsonl")
      const before = yield* makeFixtureDir(["before-reconnect"])
      const after = yield* makeFixtureDir(["after-reconnect"])
      const audit = yield* spawnExample("audit-log.ts", [outfile], dataDir)
      yield* audit.waitForLine("audit-log: writing to", 30_000)
      const first = yield* runExample("bootstrap-projects.ts", [before], dataDir)
      expect(first.code, first.stderr).toBe(0)
      expect(yield* pollUntil(auditLines(outfile).pipe(Effect.map((lines) => lines.some((entry) => entry.seq === 1))), 5_000)).toBe(true)
      const firstPid = yield* endpointPid(dataDir)
      expect(firstPid).toBeTypeOf("number")
      if (firstPid === undefined) return yield* Effect.fail("missing backend pid" as const)
      const signal = yield* ChildProcess.make("kill", ["-TERM", String(firstPid)], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe"
      })
      expect(Number(yield* signal.exitCode)).toBe(0)
      expect(yield* pollUntil(endpointPid(dataDir).pipe(
        Effect.map((pid) => pid !== undefined && pid !== firstPid)
      ), 15_000)).toBe(true)
      const processControl = yield* ProcessControl
      expect(yield* processControl.probe(firstPid)).toBe("dead")
      const second = yield* runExample("bootstrap-projects.ts", [after], dataDir)
      expect(second.code, second.stderr).toBe(0)
      expect(yield* pollUntil(auditLines(outfile).pipe(Effect.map((lines) => lines.some((entry) => entry.seq === 2))), 5_000)).toBe(true)
      expect((yield* auditLines(outfile)).map((entry) => entry.seq)).toEqual([1, 2])
    })).pipe(Effect.provide(ProcessServices.layer)), 60_000)
})
