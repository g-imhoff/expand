import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, Exit, FileSystem, Layer, Path, Scope, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { describe, expect } from "vitest"
import { makeTempDirectoryScoped } from "../../../../test/support/effect-files"
import { ProcessServices } from "../process-services"
import { acquireClient } from "../../rpc-client"
import { makeNodeAdapter } from "../../adapters/node"
import { AppContext, makeAppContext } from "@expand/contracts/app-context"
import { ProcessControl } from "@expand/contracts/process-control"

const nodeAdapter = makeNodeAdapter({
  backendCommand: Effect.succeed(["node", "--import", "tsx", "apps/server/main.ts"])
})

describe("acquireClient", () => {
  it.live("yields a ready client plus the advertised endpoint, and Health answers ok", () =>
    Effect.scoped(Effect.gen(function*() {
      const path = yield* Path.Path
      const dir = yield* makeTempDirectoryScoped("expand-acquire-")
      const context = makeAppContext(path, { homeDir: dir, cwd: dir, dataDir: dir })
      const { client, endpoint } = yield* acquireClient(nodeAdapter).pipe(
        Effect.provide(ProcessServices.layer),
        Effect.provide(Layer.succeed(AppContext, context))
      )
      const health = yield* client.Health()
      expect(health).toBe("ok")
      expect(endpoint.url.startsWith("ws://127.0.0.1:")).toBe(true)
      expect(endpoint.pid).toBeGreaterThan(0)
      expect(endpoint.token.length).toBeGreaterThan(0)
    })).pipe(Effect.provide(NodeServices.layer)))

  it.live("closes the backend, transport, and temporary directory with its owning scope", () =>
    Effect.scoped(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const processControl = yield* ProcessControl
      const parentScope = yield* Scope.Scope
      const fixtureScope = yield* Scope.fork(parentScope)
      const fixture = yield* Effect.gen(function*() {
        const directory = yield* makeTempDirectoryScoped("expand-acquire-interrupt-")
        const handle = yield* ChildProcess.make(
          "node",
          ["--import", "tsx", "apps/server/main.ts", "--data-dir", directory],
          {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe"
          }
        )
        yield* Effect.forkScoped(Stream.runDrain(handle.stdout))
        yield* Effect.forkScoped(Stream.runDrain(handle.stderr))
        const context = makeAppContext(path, {
          homeDir: directory,
          cwd: directory,
          dataDir: directory
        })
        const adapter = {
          protocolLayer: nodeAdapter.protocolLayer,
          spawnBackend: () => Effect.void
        }
        const { client } = yield* acquireClient(adapter).pipe(
          Effect.provide(Layer.succeed(AppContext, context))
        )
        expect(yield* client.Health()).toBe("ok")
        return { client, directory, handle }
      }).pipe(Scope.provide(fixtureScope))

      const pid = Number(fixture.handle.pid)
      expect(yield* processControl.probe(pid)).toBe("alive")
      yield* Scope.close(fixtureScope, Exit.fail("forced fixture failure"))
      yield* fixture.handle.exitCode.pipe(
        Effect.timeoutOrElse({
          duration: "5 seconds",
          orElse: () => Effect.fail(`backend ${pid} did not terminate`)
        })
      )
      expect(yield* processControl.probe(pid)).toBe("dead")
      expect(Exit.isFailure(yield* Effect.exit(
        fixture.client.Health().pipe(Effect.timeout("1 second"))
      ))).toBe(true)
      expect(yield* fs.exists(fixture.directory)).toBe(false)
    })).pipe(Effect.provide(ProcessServices.layer), Effect.provide(NodeServices.layer)))
})
