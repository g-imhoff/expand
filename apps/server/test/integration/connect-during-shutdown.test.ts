import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Path, Fiber, Option, Schedule, Schema, Layer } from "effect"
import { ProcessServices } from "@expand/server/runtime/node-process-control"
import { runServer } from "@expand/server/composition/app"
import { withClient } from "@expand/client-ts"
import { makeNodeAdapter } from "@expand/client-ts/adapters/node"
import { readEndpoint } from "@expand/client-ts"
import { EndpointFromJson, type Endpoint } from "@expand/contracts/endpoint"
import { PROTOCOL_VERSION } from "@expand/contracts/rpc/version"
import { ProcessControl } from "@expand/contracts/process-control"
import { AppContext, makeAppContext } from "@expand/contracts/app-context"

const nodeAdapter = makeNodeAdapter({
  backendCommand: Effect.succeed(["node", "--import", "tsx", "apps/server/main.ts"])
})
const reviverOwnedAdapter = {
  protocolLayer: nodeAdapter.protocolLayer,
  spawnBackend: () => Effect.void
}

// Regression for Bug 2 (connect-during-shutdown race): a command must NOT hang
// when discovery hands it a stale endpoint pointing at a dead/dying server. The
// client must bound the connect, delete the stale file, and re-discover a healthy
// server instead of blocking forever on a dead socket.


const writeTestEndpoint = (file: string, endpoint: Endpoint) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const encoded = yield* Schema.encodeEffect(EndpointFromJson)(endpoint)
    yield* fs.writeFileString(file, encoded)
  })

describe.sequential("connect-during-shutdown race (Bug 2)", () => {
  it.live(
    "does not hang on a stale endpoint: times out, deletes it, re-discovers a healthy server",
     () => Effect.gen(function*() {
    const path = yield* Path.Path.pipe(Effect.provide(NodeServices.layer))
    const dir = yield* makeTestDirectory('expand-connect-during-shutdown-')
      const program = Effect.gen(function* () {
        const dbPath = path.join(dir, "events.db")

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
            orElse: () => Effect.fail("real server never advertised")
          })
        )

        // Now poison discovery with a stale endpoint (dead port). The first client
        // attempt will connect to nothing, time out, and delete this file.
        const processControl = yield* ProcessControl
        const endpointFile = makeTestAppContext(path, dir).paths.endpointFile
        yield* writeTestEndpoint(endpointFile, {
          url: "ws://127.0.0.1:9/rpc",
          token: "stale",
          pid: processControl.currentPid,
          protocolVersion: PROTOCOL_VERSION
        })

        // Background: the instant the client deletes the stale file (its retry
        // path), re-advertise the REAL endpoint so the retry discovers a healthy
        // server. This stands in for a freshly-spawned server appearing.
        const reviver = yield* Effect.forkChild(
          readEndpoint.pipe(
            Effect.flatMap((o) =>
              Option.isNone(o) ? Effect.void : Effect.fail("still-stale" as const)
            ),
            Effect.retry(Schedule.spaced("10 millis")),
            Effect.andThen(writeTestEndpoint(endpointFile, realEndpoint))
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
            orElse: () => Effect.fail("withClient HUNG on a stale endpoint (Bug 2 regression)")
          })
        )

        yield* Fiber.join(reviver)
        yield* Fiber.interrupt(serverFiber)
        return result
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(ProcessServices.layer, Layer.succeed(AppContext, makeTestAppContext(path, dir)))))

      const r = yield* (program)
      expect(r.health).toBe("ok")
      expect(r.created.project.name).toBe("after-stale")
    }),
    20000
  )
})

const makeTestDirectory = (prefix: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix })),
    Effect.provide(NodeServices.layer)
  )

const makeTestAppContext = (path: Path.Path, dataDir: string) =>
  makeAppContext(path, { homeDir: dataDir, cwd: dataDir, dataDir })
