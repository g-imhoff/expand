import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect, Layer } from "effect"
import {
  BackendConnectionStore,
  backendConnectionHandlers,
  makeBackendConnectionStore
} from "@expand/desktop/main/rpc/backend-connection-handlers"
import { defaultBackendAdapter } from "@expand/desktop/main/runtime/client-runtime"

const storeLayer = Layer.effect(BackendConnectionStore, makeBackendConnectionStore())

describe("backend connection (T17)", () => {
  it.effect("switches between local and personal remote backends", () =>
    Effect.gen(function*() {
      const get = backendConnectionHandlers.BackendConnectionGet as () => Effect.Effect<unknown>
      const set = backendConnectionHandlers.BackendConnectionSet as (p: unknown) => Effect.Effect<unknown>
      const initial = (yield* (get() as Effect.Effect<{ readonly mode: string }>).pipe(Effect.provide(storeLayer))) as { readonly mode: string }
      expect(initial.mode).toBe("local")
      const remote = { mode: "remote", url: "ws://127.0.0.1:4123/rpc", token: "tok" } as const
      const stored = (yield* (set(remote) as Effect.Effect<{ readonly mode: string; readonly url?: string }>).pipe(Effect.provide(storeLayer))) as { readonly mode: string; readonly url?: string }
      expect(stored.mode).toBe("remote")
      expect(stored.url).toContain("127.0.0.1")
      const back = (yield* (set({ mode: "local" }) as Effect.Effect<{ readonly mode: string }>).pipe(Effect.provide(storeLayer))) as { readonly mode: string }
      expect(back.mode).toBe("local")
    }))

  it.effect("rejects remote connections without url or token", () =>
    Effect.gen(function*() {
      const set = backendConnectionHandlers.BackendConnectionSet as unknown as (
        p: unknown
      ) => Effect.Effect<unknown, { readonly field: string }>
      const test = backendConnectionHandlers.BackendConnectionTest as (p: unknown) => Effect.Effect<unknown>
      const cases = [
        [{ mode: "remote", url: "", token: "t" }, "url"],
        [{ mode: "remote", url: "ws://127.0.0.1:1/rpc" }, "token"],
        [{ mode: "remote", token: "t" }, "url"]
      ] as const
      for (const [bad, field] of cases) {
        const error = yield* (set(bad) as Effect.Effect<unknown, { readonly field: string }>).pipe(
          Effect.provide(storeLayer),
          Effect.flip
        )
        expect(error.field).toBe(field)
        const testExit = yield* Effect.exit((test(bad) as Effect.Effect<unknown>).pipe(Effect.provide(storeLayer)))
        expect(testExit._tag).toBe("Failure")
      }
    }))

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
