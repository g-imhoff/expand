import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect, Layer, Path } from "effect"
import {
  BackendConnectionStore,
  backendConnectionHandlers,
  makeBackendConnectionStore
} from "@expand/desktop/main/rpc/backend-connection-handlers"
import { defaultBackendAdapter } from "@expand/desktop/main/runtime/client-runtime"
import { readRemoteConnection } from "@expand/client-ts/backend-connection"
import { AppContext, makeAppContext } from "@expand/contracts/app-context"
import { makeTempDirectoryScoped } from "../../../../test/support/effect-files"

describe("backend connection (T17)", () => {
  it.effect("switches between local and personal remote backends", () =>
    Effect.scoped(Effect.gen(function*() {
      const path = yield* Path.Path
      const dir = yield* makeTempDirectoryScoped("expand-backend-conn-")
      const context = makeAppContext(path, { homeDir: dir, cwd: dir, dataDir: dir })
      const storeLayer = Layer.effect(BackendConnectionStore, makeBackendConnectionStore())
      const layers = Layer.mergeAll(storeLayer, NodeServices.layer, Layer.succeed(AppContext, context))
      const get = backendConnectionHandlers.BackendConnectionGet as () => Effect.Effect<unknown>
      const set = backendConnectionHandlers.BackendConnectionSet as (p: unknown) => Effect.Effect<unknown>
      const initial = (yield* (get() as Effect.Effect<{ readonly mode: string }>).pipe(Effect.provide(layers))) as { readonly mode: string }
      expect(initial.mode).toBe("local")
      const remote = { mode: "remote", url: "ws://127.0.0.1:4123/rpc", token: "tok" } as const
      const stored = (yield* (set(remote) as Effect.Effect<{ readonly mode: string; readonly url?: string }>).pipe(Effect.provide(layers))) as { readonly mode: string; readonly url?: string }
      expect(stored.mode).toBe("remote")
      expect(stored.url).toContain("127.0.0.1")
      const persisted = yield* readRemoteConnection.pipe(Effect.provide(layers))
      expect(persisted).toEqual({ _tag: "remote", url: "ws://127.0.0.1:4123/rpc", token: "tok" })
      const reloadedLayer = Layer.effect(BackendConnectionStore, makeBackendConnectionStore(persisted))
      const reloaded = (yield* (get() as Effect.Effect<{ readonly mode: string }>).pipe(Effect.provide(reloadedLayer))) as { readonly mode: string }
      expect(reloaded.mode).toBe("remote")
      const back = (yield* (set({ mode: "local" }) as Effect.Effect<{ readonly mode: string }>).pipe(Effect.provide(layers))) as { readonly mode: string }
      expect(back.mode).toBe("local")
      const cleared = yield* readRemoteConnection.pipe(Effect.provide(layers))
      expect(cleared).toEqual({ _tag: "local" })
    })).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects remote connections without url or token", () =>
    Effect.scoped(Effect.gen(function*() {
      const path = yield* Path.Path
      const dir = yield* makeTempDirectoryScoped("expand-backend-conn-invalid-")
      const context = makeAppContext(path, { homeDir: dir, cwd: dir, dataDir: dir })
      const storeLayer = Layer.effect(BackendConnectionStore, makeBackendConnectionStore())
      const layers = Layer.mergeAll(storeLayer, NodeServices.layer, Layer.succeed(AppContext, context))
      const set = backendConnectionHandlers.BackendConnectionSet as unknown as (
        p: unknown
      ) => Effect.Effect<unknown, { readonly field: string }>
      const test = backendConnectionHandlers.BackendConnectionTest as (p: unknown) => Effect.Effect<unknown>
      const cases = [
        [{ mode: "remote", url: "", token: "t" }, "url"],
        [{ mode: "remote", url: "ws://127.0.0.1:1/rpc" }, "token"],
        [{ mode: "remote", token: "t" }, "url"],
        [{ mode: "remote", url: "ftp://example.com/rpc", token: "t" }, "url"]
      ] as const
      for (const [bad, field] of cases) {
        const error = yield* (set(bad) as Effect.Effect<unknown, { readonly field: string }>).pipe(
          Effect.provide(layers),
          Effect.flip
        )
        expect(error.field).toBe(field)
        const testExit = yield* Effect.exit((test(bad) as Effect.Effect<unknown>).pipe(Effect.provide(layers)))
        expect(testExit._tag).toBe("Failure")
      }
    })).pipe(Effect.provide(NodeServices.layer)))

  it.effect("guards the local-spawn path in remote mode", () =>
    Effect.gen(function*() {
      const host = {
        backendEntry: "/none",
        isPackaged: false,
        moduleUrl: new URL("file:///tmp/x.mjs"),
        awaitPackagedBackendShutdown: Effect.void,
        spawnPackagedBackend: () => Effect.void
      }
      const remoteAdapter = defaultBackendAdapter(host, { _tag: "remote", url: "ws://127.0.0.1:1/rpc", token: "t" })
      const spawn = remoteAdapter.spawnBackend as unknown as (dataDir: string) => Effect.Effect<void, { readonly _tag: string; readonly reason: string }>
      const error = yield* spawn("/tmp/expand-remote-guard").pipe(Effect.flip)
      expect(error._tag).toBe("BackendUnavailable")
      expect(error.reason.includes("refusing to spawn")).toBe(true)
    }))

  it.effect("refuses packaged spawns while switched to remote", () =>
    Effect.gen(function*() {
      let packagedSpawns = 0
      const host = {
        backendEntry: "/packaged/backend.mjs",
        isPackaged: true,
        moduleUrl: new URL("file:///tmp/x.mjs"),
        awaitPackagedBackendShutdown: Effect.void,
        spawnPackagedBackend: () => Effect.sync(() => { packagedSpawns += 1 }).pipe(Effect.asVoid)
      }
      const remoteAdapter = defaultBackendAdapter(host, { _tag: "remote", url: "ws://127.0.0.1:1/rpc", token: "t" })
      const spawn = remoteAdapter.spawnBackend as unknown as (dataDir: string) => Effect.Effect<void, { readonly _tag: string; readonly reason: string }>
      const error = yield* spawn("/tmp/expand-remote-packaged").pipe(Effect.flip)
      expect(error._tag).toBe("BackendUnavailable")
      expect(error.reason.includes("refusing to spawn")).toBe(true)
      expect(packagedSpawns).toBe(0)
    }))

  it.effect("reports unreachable for a closed loopback port", () =>
    Effect.gen(function*() {
      const test = backendConnectionHandlers.BackendConnectionTest as (p: unknown) => Effect.Effect<{ readonly reachable: boolean; readonly authorized: boolean }>
      const result = yield* test({ mode: "remote", url: "ws://127.0.0.1:1/rpc", token: "x" })
      expect(result.reachable).toBe(false)
      expect(result.authorized).toBe(false)
    }))
})
