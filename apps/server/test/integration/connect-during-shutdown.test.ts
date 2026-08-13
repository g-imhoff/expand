import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Path, Fiber, Option, Queue, Schedule, Schema, Layer } from "effect"
import { ProcessServices } from "@expand/server/runtime/node-process-control"
import { runServer } from "@expand/server/composition/app"
import { BackendUnavailable, readEndpoint, withClient } from "@expand/client-ts"
import { makeNodeAdapter } from "@expand/client-ts/adapters/node"
import { EndpointFromJson, type Endpoint } from "@expand/contracts/endpoint"
import { PROTOCOL_VERSION } from "@expand/contracts/rpc/version"
import { ProcessControl } from "@expand/contracts/process-control"
import { AppContext, makeAppContext } from "@expand/contracts/app-context"

const nodeAdapter = makeNodeAdapter({
  backendCommand: Effect.succeed(["node", "--import", "tsx", "apps/server/main.ts"])
})
const writeTestEndpoint = (file: string, endpoint: Endpoint) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const encoded = yield* Schema.encodeEffect(EndpointFromJson)(endpoint)
    yield* fs.writeFileString(file, encoded)
  })

describe.sequential("connect-during-shutdown race (Bug 2)", () => {
  it.live(
    "does not hang on a stale endpoint and preserves a healthy replacement",
    () => Effect.gen(function*() {
      const path = yield* Path.Path.pipe(Effect.provide(NodeServices.layer))
      const dir = yield* makeTestDirectory("expand-connect-during-shutdown-")
      const program = Effect.gen(function* () {
        const dbPath = path.join(dir, "events.db")
        const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
        const realEndpoint = yield* readEndpoint.pipe(
          Effect.flatMap((o) => (Option.isSome(o) ? Effect.succeed(o.value) : Effect.fail("pending" as const))),
          Effect.retry(Schedule.spaced("25 millis")),
          Effect.timeoutOrElse({
            duration: "5 seconds",
            orElse: () => Effect.fail("real server never advertised")
          })
        )
        const processControl = yield* ProcessControl
        const endpointFile = makeTestAppContext(path, dir).paths.endpointFile
        yield* writeTestEndpoint(endpointFile, {
          url: "ws://127.0.0.1:9/rpc",
          token: "stale",
          pid: processControl.currentPid,
          protocolVersion: PROTOCOL_VERSION
        })
        const attempts = yield* Queue.unbounded<string>()
        const adapter = {
          protocolLayer: (url: string) => {
            Queue.offerUnsafe(attempts, url)
            return nodeAdapter.protocolLayer(url)
          },
          spawnBackend: () => Effect.fail(new BackendUnavailable({
            reason: "replacement endpoint should be discovered without spawning"
          }))
        }
        const clientFiber = yield* withClient(adapter, (client) =>
          Effect.gen(function* () {
            const health = yield* client.Health()
            const created = yield* client.ProjectCreate({ name: "after-stale", ensure: false })
            const advertised = yield* FileSystem.FileSystem.pipe(
              Effect.flatMap((fs) => fs.readFileString(endpointFile)),
              Effect.flatMap(Schema.decodeUnknownEffect(EndpointFromJson))
            )
            return { advertised, health, created }
          })
        ).pipe(
          Effect.timeoutOrElse({
            duration: "10 seconds",
            orElse: () => Effect.fail("withClient HUNG on a stale endpoint (Bug 2 regression)")
          }),
          Effect.forkChild
        )
        expect(yield* Queue.take(attempts)).toContain("127.0.0.1:9")
        yield* writeTestEndpoint(endpointFile, realEndpoint)
        const result = yield* Fiber.join(clientFiber)
        yield* Fiber.interrupt(serverFiber)
        return { ...result, replacement: realEndpoint }
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(ProcessServices.layer, Layer.succeed(AppContext, makeTestAppContext(path, dir)))))

      const r = yield* program
      expect(r.health).toBe("ok")
      expect(r.created.project.name).toBe("after-stale")
      expect(r.advertised).toEqual(r.replacement)
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
