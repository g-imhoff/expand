import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Deferred, Effect, Fiber, Option } from "effect"
import { TestClock } from "effect/testing"
import { BunServices } from "@effect/platform-bun"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findOrSpawnBackend } from "../../spawn"
import { bunAdapter } from "../../adapters/bun"
import { type Endpoint, PROTOCOL_VERSION } from "@expand/contracts/endpoint"
import { makeTestAppContext } from "@expand/contracts/app-context.testkit"
import { Layer } from "effect"
import type { BackendUnavailable } from "../../errors"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "expand-spawn-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("findOrSpawnBackend", () => {
  it("returns the existing live backend without spawning", async () => {
    writeFileSync(
      makeTestAppContext(dir).paths.endpointFile,
      JSON.stringify({
        url: "ws://127.0.0.1:51789/rpc",
        token: "t",
        pid: process.pid,
        protocolVersion: PROTOCOL_VERSION
      })
    )
    const endpoint = await Effect.runPromise(
      Effect.provide(findOrSpawnBackend(bunAdapter), Layer.mergeAll(BunServices.layer, makeTestAppContext(dir).layer))
    )
    expect(endpoint.url).toBe("ws://127.0.0.1:51789/rpc")
    expect(endpoint.pid).toBe(process.pid)
  })

  it("waits for a valid endpoint advertised at six seconds", async () => {
    const realEndpoint = {
      url: "ws://127.0.0.1:51791/rpc",
      token: "slow-start",
      pid: process.pid,
      protocolVersion: PROTOCOL_VERSION
    }

    const program = Effect.gen(function* () {
      const spawned = yield* Deferred.make<void>()
      const adapter = {
        ...bunAdapter,
        spawnBackend: () => Deferred.succeed(spawned, undefined).pipe(Effect.asVoid)
      }
      const advertiser = yield* Effect.sleep("6 seconds").pipe(
        Effect.andThen(
          Effect.sync(() => writeFileSync(makeTestAppContext(dir).paths.endpointFile, JSON.stringify(realEndpoint)))
        ),
        Effect.forkChild
      )
      const finder = yield* findOrSpawnBackend(adapter).pipe(Effect.forkChild)
      yield* Deferred.await(spawned)
      yield* Effect.yieldNow
      yield* TestClock.adjust("6 seconds")
      yield* TestClock.adjust("50 millis")
      const endpoint = yield* Fiber.join(finder)
      yield* Fiber.join(advertiser)
      return endpoint
    }).pipe(
      Effect.provide(TestClock.layer()),
      Effect.provide(BunServices.layer),
      Effect.provide(makeTestAppContext(dir).layer)
    )

    const endpoint = await Effect.runPromise(program)
    expect(endpoint.url).toBe(realEndpoint.url)
  })

  it("fails when the backend has not advertised by ten seconds", async () => {
    const program = Effect.gen(function* () {
      const spawned = yield* Deferred.make<void>()
      const adapter = {
        ...bunAdapter,
        spawnBackend: () => Deferred.succeed(spawned, undefined).pipe(Effect.asVoid)
      }
      const completed = yield* Deferred.make<Endpoint, BackendUnavailable | "pending">()
      yield* Deferred.complete(completed, findOrSpawnBackend(adapter)).pipe(Effect.forkChild)
      yield* Deferred.await(spawned)
      yield* Effect.yieldNow
      yield* TestClock.adjust("9 seconds")
      const beforeDeadline = yield* Deferred.poll(completed)
      yield* TestClock.adjust("1 second")
      const result = yield* Deferred.await(completed).pipe(Effect.result)
      return { beforeDeadline, result }
    }).pipe(
      Effect.provide(TestClock.layer()),
      Effect.provide(BunServices.layer),
      Effect.provide(makeTestAppContext(dir).layer)
    )

    const { beforeDeadline, result } = await Effect.runPromise(program)
    expect(Option.isNone(beforeDeadline)).toBe(true)
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "BackendUnavailable", reason: "backend did not start in time" }
    })
  })

  // Regression for the stale-spawn-lock wedge: a spawner SIGKILLed AFTER acquiring
  // `<endpoint>.lock` but BEFORE advertising `server.json` would orphan the lock
  // forever, so every later command failed with BackendUnavailable and never
  // re-spawned (pre-fix). The acquire must now detect the dead-pid lock as stale,
  // clear it, and proceed to spawn instead of waiting out the timeout and failing.
  it("recovers from a stale (dead-pid) spawn lock with no server.json", async () => {
    const lockPath = `${makeTestAppContext(dir).paths.endpointFile}.lock`
    // Orphaned lock: a dead pid (out-of-range -> ESRCH -> treated as dead). No
    // server.json exists, so readEndpoint is None and we go straight to acquire.
    writeFileSync(lockPath, JSON.stringify({ pid: 2147483647, startedAt: Date.now() }))

    const realEndpoint = {
      url: "ws://127.0.0.1:51790/rpc",
      token: "fresh",
      pid: process.pid,
      protocolVersion: PROTOCOL_VERSION
    }

    const program = Effect.gen(function* () {
      // Stand in for the freshly-spawned server: once the acquire has cleared the
      // stale lock and (no-op) spawn fires, advertise a live endpoint so the
      // acquiring fiber's awaitEndpoint resolves instead of timing out.
      const reviver = yield* Effect.forkChild(
        Effect.sync(() => writeFileSync(makeTestAppContext(dir).paths.endpointFile, JSON.stringify(realEndpoint))).pipe(
          Effect.delay("100 millis")
        )
      )
      // Pre-fix: this would wait the full 10s awaitEndpoint window and then fail
      // with BackendUnavailable, never clearing the lock. Post-fix: it clears the
      // stale lock, "spawns", and returns the advertised endpoint.
      const endpoint = yield* findOrSpawnBackend(bunAdapter)
      yield* Fiber.join(reviver)
      return endpoint
    }).pipe(Effect.provide(BunServices.layer), Effect.provide(makeTestAppContext(dir).layer))

    const endpoint = await Effect.runPromise(program)
    expect(endpoint.url).toBe(realEndpoint.url)
    // The stale lock was cleared (acquired then released via Effect.ensuring).
    expect(existsSync(lockPath)).toBe(false)
  })
})
