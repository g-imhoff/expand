import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path } from "effect"
import { describe, expect } from "vitest"
import { makeTempDirectoryScoped } from "../../../../test/support/effect-files"
import { ProcessServices } from "../process-services"
import { acquireClient } from "../../rpc-client"
import { makeNodeAdapter } from "../../adapters/node"
import { AppContext, makeAppContext } from "@expand/contracts/app-context"

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

  it.live("removes its scoped temporary directory after interruption", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* Effect.scoped(makeTempDirectoryScoped("expand-acquire-interrupt-"))
      expect(yield* fs.exists(directory)).toBe(false)
    }).pipe(Effect.provide(NodeServices.layer)))
})
