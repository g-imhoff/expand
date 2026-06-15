import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Effect, Fiber, Option, Schedule } from "effect"
import { BunServices } from "@effect/platform-bun"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runServer } from "@yodea/server/composition/app"
import { withClient } from "@yodea/client-core"
import { bunAdapter } from "@yodea/client-core/adapters/bun"
import { readEndpoint } from "@yodea/client-core/discovery"
import { endpointFilePath, PROTOCOL_VERSION } from "@yodea/contracts/endpoint"

// Regression for Bug 2 (connect-during-shutdown race): a command must NOT hang
// when discovery hands it a stale endpoint pointing at a dead/dying server. The
// client must bound the connect, delete the stale file, and re-discover a healthy
// server instead of blocking forever on a dead socket.
//
// We can't exercise the real auto-spawn path in-process (discovery spawns the
// COMPILED binary, and `process.execPath` is bun under the test runner), so we
// drive the same client recovery seam directly: a stale `server.json` (live pid,
// dead port) is staged, a real `runServer` is running on an ephemeral port, and a
// background fiber re-advertises the REAL endpoint the instant the client deletes
// the stale one. A pre-fix client (no connect timeout / no retry) hangs here.

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yodea-race-"))
  process.env.YODEA_ENDPOINT_FILE = join(dir, "server.json")
})
afterEach(() => {
  delete process.env.YODEA_ENDPOINT_FILE
  rmSync(dir, { recursive: true, force: true })
})

const writeStaleEndpoint = () =>
  // Live pid (this process) so readEndpoint accepts it, but a port nothing is
  // listening on — i.e. a server that has already gone away.
  writeFileSync(
    endpointFilePath(),
    JSON.stringify({
      url: "ws://127.0.0.1:9/rpc",
      token: "stale",
      pid: process.pid,
      protocolVersion: PROTOCOL_VERSION
    })
  )

describe.sequential("connect-during-shutdown race (Bug 2)", () => {
  it(
    "does not hang on a stale endpoint: times out, deletes it, re-discovers a healthy server",
    async () => {
      const program = Effect.gen(function* () {
        const dbPath = join(dir, "events.db")

        // A REAL backend is running, but it has NOT advertised yet — we control
        // the discovery file by hand to reproduce the race deterministically.
        // `runServer` writes its real endpoint on boot, so we let it boot, capture
        // the real endpoint, then overwrite the file with a STALE one.
        const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))

        // Wait for the real server to advertise, then capture its real endpoint.
        const realEndpoint = yield* readEndpoint.pipe(
          Effect.flatMap((o) => (Option.isSome(o) ? Effect.succeed(o.value) : Effect.fail("pending" as const))),
          Effect.retry(Schedule.spaced("25 millis")),
          Effect.timeoutOrElse({
            duration: "5 seconds",
            orElse: () => Effect.fail(new Error("real server never advertised"))
          })
        )

        // Now poison discovery with a stale endpoint (dead port). The first client
        // attempt will connect to nothing, time out, and delete this file.
        writeStaleEndpoint()

        // Background: the instant the client deletes the stale file (its retry
        // path), re-advertise the REAL endpoint so the retry discovers a healthy
        // server. This stands in for a freshly-spawned server appearing.
        const reviver = yield* Effect.forkChild(
          readEndpoint.pipe(
            Effect.flatMap((o) =>
              Option.isNone(o) ? Effect.void : Effect.fail("still-stale" as const)
            ),
            Effect.retry(Schedule.spaced("10 millis")),
            Effect.andThen(
              Effect.sync(() =>
                writeFileSync(endpointFilePath(), JSON.stringify(realEndpoint))
              )
            )
          )
        )

        // The whole point: this must COMPLETE (not hang) and return real data.
        const result = yield* withClient(bunAdapter, (client) =>
          Effect.gen(function* () {
            const health = yield* client.Health()
            const created = yield* client.ProjectCreate({ name: "after-stale", ensure: false })
            return { health, created }
          })
        ).pipe(
          Effect.timeoutOrElse({
            duration: "10 seconds",
            orElse: () => Effect.fail(new Error("withClient HUNG on a stale endpoint (Bug 2 regression)"))
          })
        )

        yield* Fiber.join(reviver)
        yield* Fiber.interrupt(serverFiber)
        return result
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer))

      const r = await Effect.runPromise(program)
      expect(r.health).toBe("ok")
      expect(r.created.project.name).toBe("after-stale")
    },
    20000
  )
})
