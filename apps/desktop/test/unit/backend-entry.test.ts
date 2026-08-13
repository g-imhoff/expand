import { it } from "@effect/vitest"
import { NodePath, NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import {
  defaultBackendEntry,
  defaultBackendAdapter
} from "@expand/desktop/main/runtime/client-runtime"

describe("desktop default backend entry", () => {
  it.effect("resolves the bundled main module path to apps/server/main.ts", () =>
    Effect.gen(function* () {
      const entry = yield* defaultBackendEntry(new URL("file:///repo/apps/desktop/out/main/index.mjs"))
      expect(entry).toBe("/repo/apps/server/main.ts")
    }).pipe(Effect.provide(NodePath.layer)))

  it.effect("resolves the source main module path to apps/server/main.ts", () =>
    Effect.gen(function* () {
      const entry = yield* defaultBackendEntry(new URL("file:///repo/apps/desktop/src/main/runtime/client-runtime.ts"))
      expect(entry).toBe("/repo/apps/server/main.ts")
    }).pipe(Effect.provide(NodePath.layer)))

  it.effect("launches the packaged backend from the application archive through a utility process", () =>
    Effect.gen(function* () {
      const launches: Array<{ readonly backendEntry: string; readonly dataDir: string }> = []
      const adapter = defaultBackendAdapter({
        backendEntry: "/staged/Expand/resources/app.asar/build/backend.mjs",
        isPackaged: true,
        moduleUrl: new URL("file:///staged/Expand/resources/app.asar/out/main/index.mjs"),
        awaitPackagedBackendShutdown: Effect.void,
        spawnPackagedBackend: (backendEntry, dataDir) => Effect.sync(() => {
          launches.push({ backendEntry, dataDir })
        })
      })
      yield* adapter.spawnBackend("/state")
      expect(launches).toEqual([{
        backendEntry: "/staged/Expand/resources/app.asar/build/backend.mjs",
        dataDir: "/state"
      }])
    }).pipe(Effect.provide(NodeServices.layer)))
})
