import { NodeServices } from "@effect/platform-node"
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import { it } from "@effect/vitest"
import { Cause, Effect, Exit, Fiber, FileSystem, Layer, Path, Queue, Ref, Schedule, Schema, SubscriptionRef } from "effect"
import { TestClock } from "effect/testing"
import * as Socket from "effect/unstable/socket/Socket"
import { describe, expect } from "vitest"
import { EndpointFromJson } from "@expand/contracts/endpoint"
import type { ProjectClientApi } from "@expand/client-ts/project"
import { ProjectClient } from "@expand/client-ts/project"
import { ArchiveRpcError, archiveStale, waitForBackendShutdown } from "../archive-stale"
import { ExampleReadinessError, makeDataDir, makeFixtureDir, runExample, spawnExample, waitForLine } from "./helpers"

const clientLayer = (client: ProjectClientApi) => Layer.succeed(ProjectClient, client)

describe("example: archive-stale", () => {
  it.effect("uses TestClock-compatible bounded polling for backend shutdown", () => {
    let checks = 0
    return Effect.gen(function*() {
      const fiber = yield* waitForBackendShutdown("/state/backend.lock").pipe(
        Effect.provide(FileSystem.layerNoop({
          exists: () => Effect.sync(() => ++checks < 3)
        })),
        Effect.forkChild({ startImmediately: true })
      )
      yield* Effect.yieldNow
      expect(checks).toBe(1)
      yield* TestClock.adjust("50 millis")
      expect(checks).toBe(2)
      yield* TestClock.adjust("50 millis")
      yield* Fiber.join(fiber)
      expect(checks).toBe(3)
    })
  })

  it.effect("reports list RPC failures through the typed channel", () => {
    const client = {
      list: () => Effect.fail({ reason: "rpc" })
    } as unknown as ProjectClientApi
    return archiveStale.pipe(
      Effect.provide(FileSystem.layerNoop({})),
      Effect.provide(clientLayer(client)),
      Effect.flip,
      Effect.tap((error) => Effect.sync(() => {
        expect(error).toBeInstanceOf(ArchiveRpcError)
        if (error._tag === "ArchiveRpcError") expect(error.operation).toBe("list")
      }))
    )
  })

  it.live("launches the executable during backend shutdown overlap and archives the stale project", () =>
    Effect.scoped(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dataDir = yield* makeDataDir()
      const fixture = yield* makeFixtureDir(["gone"]) // becomes project "gone" -> <fixture>/gone
      const endpointFile = path.join(dataDir, "server.json")
      const backendLockFile = path.join(dataDir, "backend.lock")
      const audit = yield* spawnExample("audit-log.ts", [path.join(dataDir, "audit.jsonl")], dataDir)
      yield* audit.waitForLine("audit-log: writing to", 30_000)
      const bootstrap = yield* runExample("bootstrap-projects.ts", [fixture], dataDir)
      expect(bootstrap.code, bootstrap.stderr).toBe(0)
      yield* fs.remove(path.join(fixture, "gone"), { recursive: true, force: true }) // its directory is now stale

      const endpoint = yield* fs.readFileString(endpointFile).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(EndpointFromJson))
      )
      const opened = yield* Queue.unbounded<void>()
      const socket = yield* Socket.makeWebSocket(`${endpoint.url}?token=${encodeURIComponent(endpoint.token)}`).pipe(
        Effect.provide(NodeSocket.layerWebSocketConstructorWS)
      )
      yield* socket.runRaw(() => undefined, { onOpen: Queue.offer(opened, undefined) }).pipe(Effect.forkScoped)
      yield* Queue.take(opened).pipe(Effect.timeout("5 seconds"))
      const overlap = yield* Effect.all([fs.exists(endpointFile), fs.exists(backendLockFile)]).pipe(
        Effect.filterOrFail(([advertised, locked]) => !advertised && locked, () => "pending" as const),
        Effect.retry(Schedule.addDelay(Schedule.recurs(5_000), () => Effect.succeed("1 millis"))),
        Effect.timeout("5 seconds"),
        Effect.forkChild({ startImmediately: true })
      )
      yield* audit.kill
      yield* Fiber.join(overlap)

      const result = yield* runExample("archive-stale.ts", [], dataDir)
      expect(result.code, result.stderr).toBe(0)
      expect(result.stdout).toMatch(/archive-stale: archived 1 of 1 active/)
    })).pipe(Effect.provide(NodeServices.layer)), 45_000)

  it.effect("interrupts readiness watchers immediately on success", () =>
    Effect.scoped(Effect.gen(function*() {
      const lines = yield* SubscriptionRef.make<ReadonlyArray<string>>([])
      const releases = yield* Ref.make(0)
      const close = yield* Effect.cached(Ref.update(releases, (count) => count + 1))
      yield* SubscriptionRef.set(lines, ["ready"])
      yield* waitForLine(lines, Effect.never, close, "ready", 1_000)
      expect(lines.pubsub.subscribers.size).toBe(0)
      expect(yield* Ref.get(releases)).toBe(0)
    })))

  it.live("closes readiness watchers and the process once after a caught timeout", () =>
    Effect.scoped(Effect.gen(function*() {
      const lines = yield* SubscriptionRef.make<ReadonlyArray<string>>([])
      const releases = yield* Ref.make(0)
      const terminated = yield* Queue.unbounded<void>()
      const close = yield* Effect.cached(Ref.update(releases, (count) => count + 1).pipe(
        Effect.andThen(Queue.offer(terminated, undefined)),
        Effect.asVoid
      ))
      const timeout = yield* Effect.exit(waitForLine(lines, Queue.take(terminated), close, "missing", 10))
      const replay = yield* Effect.exit(close)
      expect(Exit.isFailure(timeout)).toBe(true)
      if (Exit.isFailure(timeout)) {
        const error = Exit.findErrorOption(timeout).pipe((option) => option._tag === "Some" ? option.value : undefined)
        expect(error).toBeInstanceOf(ExampleReadinessError)
        expect(error).toEqual(expect.objectContaining({ reason: "timeout" }))
      }
      expect(Exit.isSuccess(replay)).toBe(true)
      expect(lines.pubsub.subscribers.size).toBe(0)
      expect(yield* Ref.get(releases)).toBe(1)
      const dataDir = yield* makeDataDir()
      const handle = yield* spawnExample("audit-log.ts", ["ignored.jsonl"], dataDir)
      const readiness = yield* Effect.exit(handle.waitForLine("missing", 10))
      expect(Exit.isFailure(readiness)).toBe(true)
      if (Exit.isFailure(readiness)) {
        const error = Exit.findErrorOption(readiness).pipe((option) => option._tag === "Some" ? option.value : undefined)
        expect(error).toBeInstanceOf(ExampleReadinessError)
        expect(error).toEqual(expect.objectContaining({ reason: "timeout" }))
      }
      const processExit = yield* Effect.exit(handle.awaitExit).pipe(Effect.timeout("5 seconds"))
      expect(Exit.isFailure(processExit)).toBe(true)
      if (Exit.isFailure(processExit)) {
        expect(Exit.findErrorOption(processExit).pipe((option) => option._tag === "Some" ? option.value : undefined)).toEqual(expect.objectContaining({ operation: "exit" }))
        expect(Cause.pretty(processExit.cause)).toContain("SIGTERM")
      }
    }).pipe(Effect.provide(NodeServices.layer))))

  it.live("retains readiness and cleanup failures together", () =>
    Effect.scoped(Effect.gen(function*() {
      const lines = yield* SubscriptionRef.make<ReadonlyArray<string>>([])
      const failure = yield* Effect.exit(waitForLine(
        lines,
        Effect.never,
        Effect.fail("cleanup failed" as const),
        "missing",
        10
      ))
      expect(Exit.isFailure(failure)).toBe(true)
      if (Exit.isFailure(failure)) {
        expect(Exit.findErrorOption(failure).pipe((option) => option._tag === "Some" ? option.value : undefined)).toBeInstanceOf(ExampleReadinessError)
        expect(Cause.pretty(failure.cause)).toContain("cleanup failed")
      }
      expect(lines.pubsub.subscribers.size).toBe(0)
    })))

  it.effect("closes readiness watchers and the process once after startup failure", () =>
    Effect.scoped(Effect.gen(function*() {
      const lines = yield* SubscriptionRef.make<ReadonlyArray<string>>([])
      const releases = yield* Ref.make(0)
      const close = yield* Effect.cached(Ref.update(releases, (count) => count + 1))
      const failure = yield* Effect.exit(waitForLine(lines, Effect.void, close, "missing", 1_000))
      expect(Exit.isFailure(failure)).toBe(true)
      if (Exit.isFailure(failure)) {
        expect(Exit.findErrorOption(failure).pipe((option) => option._tag === "Some" ? option.value : undefined)).toBeInstanceOf(ExampleReadinessError)
      }
      expect(lines.pubsub.subscribers.size).toBe(0)
      expect(yield* Ref.get(releases)).toBe(1)
      const dataDir = yield* makeDataDir()
      const handle = yield* spawnExample("missing-example.ts", [], dataDir)
      const startup = yield* Effect.exit(handle.waitForLine("missing", 5_000))
      expect(Exit.isFailure(startup)).toBe(true)
      if (Exit.isFailure(startup)) {
        expect(Exit.findErrorOption(startup).pipe((option) => option._tag === "Some" ? option.value : undefined)).toEqual(expect.objectContaining({ reason: "exit" }))
      }
      expect((yield* handle.awaitExit.pipe(Effect.timeout("5 seconds"))).code).not.toBe(0)
    }).pipe(Effect.provide(NodeServices.layer))))

  it.live("cleans the spawned process and owned directory after assertion failure", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      let ownedDataDir = ""
      const exit = yield* Effect.exit(Effect.scoped(Effect.gen(function*() {
        ownedDataDir = yield* makeDataDir()
        const fixture = yield* makeFixtureDir(["gone"])
        const audit = yield* spawnExample("audit-log.ts", [path.join(ownedDataDir, "audit.jsonl")], ownedDataDir)
        yield* audit.waitForLine("audit-log: writing to", 30_000)
        yield* runExample("bootstrap-projects.ts", [fixture], ownedDataDir)
        return yield* Effect.fail("assertion failed" as const)
      })))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* fs.exists(ownedDataDir)).toBe(false)
    }).pipe(Effect.provide(NodeServices.layer)))
})
