import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Effect, Fiber } from "effect"
import { BunServices } from "@effect/platform-bun"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findOrSpawnBackend } from "@yodea/cli/discovery"
import { endpointFilePath, PROTOCOL_VERSION } from "@yodea/shared/endpoint"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yodea-spawn-"))
  process.env.YODEA_ENDPOINT_FILE = join(dir, "server.json")
})
afterEach(() => {
  delete process.env.YODEA_ENDPOINT_FILE
  rmSync(dir, { recursive: true, force: true })
})

describe("findOrSpawnBackend", () => {
  it("returns the existing live backend without spawning", async () => {
    writeFileSync(
      endpointFilePath(),
      JSON.stringify({
        url: "ws://127.0.0.1:51789/rpc",
        token: "t",
        pid: process.pid,
        protocolVersion: PROTOCOL_VERSION
      })
    )
    const endpoint = await Effect.runPromise(
      Effect.provide(findOrSpawnBackend, BunServices.layer)
    )
    expect(endpoint.url).toBe("ws://127.0.0.1:51789/rpc")
    expect(endpoint.pid).toBe(process.pid)
  })

  // Regression for the stale-spawn-lock wedge: a spawner SIGKILLed AFTER acquiring
  // `<endpoint>.lock` but BEFORE advertising `server.json` would orphan the lock
  // forever, so every later command failed with BackendUnavailable and never
  // re-spawned (pre-fix). The acquire must now detect the dead-pid lock as stale,
  // clear it, and proceed to spawn instead of waiting out the timeout and failing.
  it("recovers from a stale (dead-pid) spawn lock with no server.json", async () => {
    const lockPath = `${endpointFilePath()}.lock`
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
        Effect.sync(() => writeFileSync(endpointFilePath(), JSON.stringify(realEndpoint))).pipe(
          Effect.delay("100 millis")
        )
      )
      // Pre-fix: this would wait the full 5s awaitEndpoint window and then fail
      // with BackendUnavailable, never clearing the lock. Post-fix: it clears the
      // stale lock, "spawns", and returns the advertised endpoint.
      const endpoint = yield* findOrSpawnBackend
      yield* Fiber.join(reviver)
      return endpoint
    }).pipe(Effect.provide(BunServices.layer))

    const endpoint = await Effect.runPromise(program)
    expect(endpoint.url).toBe(realEndpoint.url)
    // The stale lock was cleared (acquired then released via Effect.ensuring).
    expect(existsSync(lockPath)).toBe(false)
  })
})
