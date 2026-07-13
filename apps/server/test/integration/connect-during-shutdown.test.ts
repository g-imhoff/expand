import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Effect, Fiber, Option, Schedule, Layer } from "effect"
import { NodeServices } from "@effect/platform-node"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runServer } from "@expand/server/composition/app"
import { withClient } from "@expand/client-ts"
import { makeNodeAdapter } from "@expand/client-ts/adapters/node"
import { readEndpoint } from "@expand/client-ts"
import { PROTOCOL_VERSION } from "@expand/contracts/endpoint"
import { AppContext, makeAppContext } from "@expand/contracts/app-context"

const nodeAdapter = makeNodeAdapter({
  backendCommand: [process.execPath, "--import", "tsx", join(process.cwd(), "apps/server/main.ts")]
})
const reviverOwnedAdapter = {
  protocolLayer: nodeAdapter.protocolLayer,
  spawnBackend: () => Effect.void
}

// Regression for Bug 2 (connect-during-shutdown race): a command must NOT hang
// when discovery hands it a stale endpoint pointing at a dead/dying server. The
// client must bound the connect, delete the stale file, and re-discover a healthy
// server instead of blocking forever on a dead socket.

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "expand-race-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const writeStaleEndpoint = () =>
  // Live pid (this process) so readEndpoint accepts it, but a port nothing is
  // listening on — i.e. a server that has already gone away.
  writeFileSync(
    makeTestAppContext(dir).paths.endpointFile,
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
                writeFileSync(makeTestAppContext(dir).paths.endpointFile, JSON.stringify(realEndpoint))
              )
            )
          )
        )

        // The whole point: this must COMPLETE (not hang) and return real data.
        const result = yield* withClient(reviverOwnedAdapter, (client) =>
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
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.provide(Layer.succeed(AppContext, makeTestAppContext(dir))))

      const r = await Effect.runPromise(program)
      expect(r.health).toBe("ok")
      expect(r.created.project.name).toBe("after-stale")
    },
    20000
  )
})

const makeTestAppContext = (dataDir: string) =>
  makeAppContext(
    { join, resolve: (...paths) => paths[paths.length - 1] ?? "" },
    { homeDir: dataDir, cwd: dataDir, dataDir }
  )
