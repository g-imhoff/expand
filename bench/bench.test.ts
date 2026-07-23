import { NodeServices } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, FileSystem, Layer, Path, Ref } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { TestClock } from "effect/testing"
import { describe, expect } from "vitest"
import {
  BenchmarkGcUnavailable,
  BenchmarkHost,
  type MachineInfo,
  makeBenchmarkHostLayer,
  withRss
} from "./rss"
import {
  BenchmarkScenarioError,
  type Measurement,
  makeReportMetadata,
  renderReport,
  toJsonReport
} from "./report"
import { ensureSeed } from "./seed"
import { runColdBoot } from "./scenarios/cold-boot"
import { runRpcReplay } from "./scenarios/rpc-replay"
import { runScanDrain } from "./scenarios/scan-drain"
import { runServerE2e, withServer } from "./scenarios/server-e2e"
import { runWarmBoot } from "./scenarios/warm-boot"

const machine: MachineInfo = {
  cpu: "test cpu",
  cores: 4,
  nodeVersion: "v24.15.0",
  platform: "test",
  arch: "x64",
  totalMemGb: 16
}

const testHost = Layer.succeed(BenchmarkHost, BenchmarkHost.of({
  rss: Effect.succeed(0),
  gc: Effect.void,
  machineInfo: Effect.succeed(machine)
}))

const benchmarkServices = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(
  Effect.provide(testHost),
  Effect.provide(NodeServices.layer),
  Effect.scoped
)

const measurement: Measurement = {
  key: "s4-scan-drain",
  label: "S4 scan drain",
  scale: "100k",
  wallMs: 500,
  events: 100_000,
  rssDeltaBytes: 10 * 1024 * 1024
}

describe("benchmark host and reporting", () => {
  it.effect("uses the injected host and TestClock for deterministic metadata", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(1_767_225_600_000)
      const metadata = yield* makeReportMetadata

      expect(metadata).toEqual({ machine, generatedAt: "2026-01-01T00:00:00.000Z" })
      expect(renderReport([measurement], 1000, metadata.machine)).toMatchSnapshot()
      expect(toJsonReport([measurement], metadata)).toMatchSnapshot()
    }).pipe(
      Effect.provide(Layer.succeed(BenchmarkHost, BenchmarkHost.of({
        rss: Effect.succeed(0),
        gc: Effect.void,
        machineInfo: Effect.succeed(machine)
      }))),
      Effect.provide(TestClock.layer())
    ))

  it.effect("handles an unavailable host GC and samples without native intervals", () =>
    Effect.gen(function*() {
      const calls = yield* Ref.make(0)
      const host = Layer.succeed(BenchmarkHost, BenchmarkHost.of({
        rss: Ref.updateAndGet(calls, (n) => n + 1).pipe(Effect.map((n) => n * 10)),
        gc: Effect.fail(new BenchmarkGcUnavailable()),
        machineInfo: Effect.succeed(machine)
      }))
      const sampled = yield* withRss(Effect.succeed("ok")).pipe(
        Effect.scoped,
        Effect.provide(host)
      )

      expect(sampled).toEqual({ value: "ok", rssDeltaBytes: 10 })
      expect(yield* Ref.get(calls)).toBe(2)
    }).pipe(Effect.provide(TestClock.layer())))

  it.effect("calls the exact host adapter operations", () => {
    const calls: Array<string> = []
    return Effect.gen(function*() {
      const host = yield* BenchmarkHost
      expect(yield* host.rss).toBe(123)
      yield* host.gc
      expect(yield* host.machineInfo).toEqual(machine)
      expect(calls).toEqual(["rss", "gc", "machine"])
    }).pipe(Effect.provide(makeBenchmarkHostLayer({
      rss: () => {
        calls.push("rss")
        return 123
      },
      gc: () => {
        calls.push("gc")
      },
      machineInfo: () => {
        calls.push("machine")
        return machine
      }
    })))
  })

  it.effect("interrupts the scoped sampler without another scheduled sample", () =>
    Effect.gen(function*() {
      const calls = yield* Ref.make(0)
      const started = yield* Deferred.make<void>()
      const host = Layer.succeed(BenchmarkHost, BenchmarkHost.of({
        rss: Ref.updateAndGet(calls, (n) => n + 1).pipe(
          Effect.tap((n) => n === 1 ? Deferred.succeed(started, undefined) : Effect.void),
          Effect.as(100)
        ),
        gc: Effect.void,
        machineInfo: Effect.succeed(machine)
      }))
      const fiber = yield* withRss(Effect.never).pipe(
        Effect.scoped,
        Effect.provide(host),
        Effect.forkChild
      )
      yield* Deferred.await(started)
      yield* TestClock.adjust("50 millis")
      const before = yield* Ref.get(calls)
      yield* Fiber.interrupt(fiber)
      yield* TestClock.adjust("1 second")

      expect(yield* Ref.get(calls)).toBe(before)
    }).pipe(Effect.provide(TestClock.layer())))
})

describe("benchmark scenarios", () => {
  it.effect("constructs scenario Effects lazily", () =>
    Effect.gen(function*() {
      const effect = runWarmBoot({ dbPath: "unused", scale: "smoke", eventCount: 0 })
      expect(Effect.isEffect(effect)).toBe(true)
      expect(yield* effect.pipe(
        Effect.provide(Layer.succeed(BenchmarkHost, BenchmarkHost.of({
          rss: Effect.succeed(0),
          gc: Effect.void,
          machineInfo: Effect.succeed(machine)
        }))),
        Effect.scoped
      )).toEqual([])
    }))

  it.effect("reports a typed scan-count failure", () =>
    Effect.gen(function*() {
      const exit = yield* runScanDrain({
        dbPath: ":memory:",
        scale: "smoke",
        eventCount: 1
      }).pipe(
        Effect.provide(Layer.succeed(BenchmarkHost, BenchmarkHost.of({
          rss: Effect.succeed(0),
          gc: Effect.void,
          machineInfo: Effect.succeed(machine)
        }))),
        Effect.scoped,
        Effect.exit
      )
      const failure = Exit.findError(exit)

      expect(failure._tag).toBe("Success")
      if (failure._tag === "Success") expect(failure.success).toBeInstanceOf(BenchmarkScenarioError)
    }))
})

describe("benchmark resources and orchestration", () => {
  it.effect("keeps the seed cache anchored to the benchmark module", () =>
    benchmarkServices(Effect.gen(function*() {
      const path = yield* Path.Path
      const modulePath = yield* path.fromFileUrl(new URL(import.meta.url))

      expect(yield* ensureSeed("smoke")).toBe(path.join(
        path.dirname(modulePath),
        ".cache",
        "events-smoke-seed42-g1.db"
      ))
    })))

  it.effect("closes SQLite on success, failure, and interruption", () =>
    benchmarkServices(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "expand-bench-sqlite-" })

      const run = <E>(name: string, use: Effect.Effect<void, E, SqlClient>) => {
        const dbPath = path.join(root, `${name}.db`)
        return Effect.gen(function*() {
          yield* use.pipe(Effect.provide(SqliteClient.layer({ filename: dbPath })), Effect.exit)
          yield* fs.remove(dbPath, { force: true })
          expect(yield* fs.exists(dbPath)).toBe(false)
        })
      }
      const create = Effect.gen(function*() {
        const sql = yield* SqlClient
        yield* sql`CREATE TABLE resource_test (value INTEGER)`
      })
      yield* run("success", create)
      yield* run("failure", create.pipe(Effect.andThen(Effect.fail("boom" as const))))

      const started = yield* Deferred.make<void>()
      const interruptedPath = path.join(root, "interrupted.db")
      const interrupted = Effect.gen(function*() {
        yield* create
        yield* Deferred.succeed(started, undefined)
        return yield* Effect.never
      }).pipe(
        Effect.provide(SqliteClient.layer({ filename: interruptedPath })),
        Effect.forkChild
      )
      const fiber = yield* interrupted
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      yield* fs.remove(interruptedPath, { force: true })
      expect(yield* fs.exists(interruptedPath)).toBe(false)
    })))

  it.live("closes the server after success", () =>
    benchmarkServices(Effect.gen(function*() {
      const dbPath = yield* ensureSeed("smoke")
      const success = yield* withServer(dbPath, (client) => client.ProjectList({ includeArchived: true }))
      expect(success.result.projects.length).toBeGreaterThan(0)
    })))

  it.live("closes the server after client failure", () =>
    benchmarkServices(Effect.gen(function*() {
      const dbPath = yield* ensureSeed("smoke")
      const failed = yield* withServer(dbPath, () => Effect.fail("expected" as const)).pipe(Effect.exit)
      expect(Exit.isFailure(failed)).toBe(true)
    })))

  it.live("closes the server on interruption", () =>
    benchmarkServices(Effect.gen(function*() {
      const dbPath = yield* ensureSeed("smoke")
      const started = yield* Deferred.make<void>()
      const fiber = yield* withServer(dbPath, () =>
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
      ).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
    })))

  it.live("runs the smoke scenarios in stable display order", () =>
    benchmarkServices(Effect.gen(function*() {
      const dbPath = yield* ensureSeed("smoke")
      const context = { dbPath, scale: "smoke", eventCount: 1_000 }
      const measurements = yield* Effect.forEach([
        runColdBoot,
        runWarmBoot,
        runScanDrain,
        runServerE2e,
        runRpcReplay
      ], (scenario) => scenario(context), { concurrency: 1 })

      expect(measurements.flat().map(({ label }) => label)).toEqual([
        "S1 cold boot (from-zero fold)",
        "S2 warm boot (tail 0)",
        "S4 scan drain (ReplayFeed.read(0))",
        "S3 e2e command (warm checkpoint)",
        "S3 e2e command (no checkpoint)",
        "S5 RPC replay drain (fromSeq 0)"
      ])
    })))
})
