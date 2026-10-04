import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Option, Path, Stream } from "effect"
import { RpcClient } from "effect/rpc"
import { describe, expect } from "vitest"
import { makeTempDirectoryScoped } from "../../../../test/support/effect-files"
import { ProcessServices } from "../process-services"
import { acquireClient } from "../../rpc-client"
import { ClientSession, ClientSessionLayer } from "../../client-session"
import {
  readRemoteConnection,
  testRemoteConnection,
  writeRemoteConnection
} from "../../backend-connection"
import { makeNodeAdapter } from "../../adapters/node"
import { AppContext, makeAppContext } from "@expand/contracts/app-context"

const nodeAdapter = makeNodeAdapter({
  backendCommand: Effect.succeed(["node", "--import", "tsx", "apps/server/main.ts"])
})

describe("remote backend (T17)", () => {
  it.live("exercises remote mode against a loopback backend with zero spawns", () =>
    Effect.scoped(Effect.gen(function*() {
      const path = yield* Path.Path
      const dir = yield* makeTempDirectoryScoped("expand-remote-")
      const context = makeAppContext(path, { homeDir: dir, cwd: dir, dataDir: dir })
      const base = Layer.mergeAll(ProcessServices.layer, Layer.succeed(AppContext, context))
      const { endpoint } = yield* acquireClient(nodeAdapter).pipe(Effect.provide(base))
      let spawns = 0
      const counting = {
        protocolLayer: nodeAdapter.protocolLayer,
        spawnBackend: () => Effect.die("remote spawnBackend must not be called") as unknown as Effect.Effect<void>
      }
      const remote = { _tag: "remote", url: endpoint.url, token: endpoint.token } as const
      const { client } = yield* acquireClient(counting, remote).pipe(Effect.provide(base))
      expect(yield* client.Health()).toBe("ok")
      const list = yield* client.ProjectList({})
      expect(Array.isArray(list.projects)).toBe(true)
      expect(spawns).toBe(0)
    })).pipe(Effect.provide(NodeServices.layer)))

  it.live("never spawns a local replacement when the remote is unavailable", () =>
    Effect.scoped(Effect.gen(function*() {
      const path = yield* Path.Path
      const dir = yield* makeTempDirectoryScoped("expand-remote-guard-")
      const context = makeAppContext(path, { homeDir: dir, cwd: dir, dataDir: dir })
      const base = Layer.mergeAll(ProcessServices.layer, Layer.succeed(AppContext, context))
      let spawns = 0
      const counting = {
        protocolLayer: nodeAdapter.protocolLayer,
        spawnBackend: () => Effect.die("remote spawnBackend must not be called") as unknown as Effect.Effect<void>
      }
      const remote = { _tag: "remote", url: "ws://127.0.0.1:1/rpc", token: "dead-token" } as const
      const error = yield* acquireClient(counting, remote).pipe(
        Effect.provide(base),
        Effect.flip
      )
      expect(error._tag).toBe("BackendUnavailable")
      expect(spawns).toBe(0)
      if (error._tag === "BackendUnavailable") {
        expect(error.reason.includes("refusing to spawn")).toBe(true)
      }
    })).pipe(Effect.provide(NodeServices.layer)))

  it.live("reports reachable and authorized status separately", () =>
    Effect.scoped(Effect.gen(function*() {
      const path = yield* Path.Path
      const dir = yield* makeTempDirectoryScoped("expand-remote-probe-")
      const context = makeAppContext(path, { homeDir: dir, cwd: dir, dataDir: dir })
      const base = Layer.mergeAll(ProcessServices.layer, Layer.succeed(AppContext, context))
      const { endpoint } = yield* acquireClient(nodeAdapter).pipe(Effect.provide(base))
      const good = { _tag: "remote", url: endpoint.url, token: endpoint.token } as const
      const badToken = { _tag: "remote", url: endpoint.url, token: "wrong-token" } as const
      const down = { _tag: "remote", url: "ws://127.0.0.1:1/rpc", token: "x" } as const
      expect(yield* testRemoteConnection(nodeAdapter, good)).toEqual({ reachable: true, authorized: true })
      const wrong = yield* testRemoteConnection(nodeAdapter, badToken)
      expect(wrong.reachable).toBe(true)
      expect(wrong.authorized).toBe(false)
      expect(yield* testRemoteConnection(nodeAdapter, down)).toEqual({ reachable: false, authorized: false })
    })).pipe(Effect.provide(NodeServices.layer)))

  it.live("persists the remote token with owner-only permissions", () =>
    Effect.scoped(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* makeTempDirectoryScoped("expand-remote-file-")
      const context = makeAppContext(path, { homeDir: dir, cwd: dir, dataDir: dir })
      const layers = Layer.mergeAll(ProcessServices.layer, Layer.succeed(AppContext, context))
      const connection = { _tag: "remote", url: "ws://127.0.0.1:4123/rpc", token: "secret-remote-token" } as const
      const stored = yield* writeRemoteConnection(connection).pipe(Effect.provide(layers))
      expect(stored).toEqual(connection)
      const back = yield* readRemoteConnection.pipe(Effect.provide(layers))
      expect(back).toEqual(connection)
      const file = path.join(dir, "remote-backend.json")
      const mode = Number((yield* fs.stat(file)).mode & 0o777)
      expect(mode).toBe(0o600)
      const missing = yield* Effect.scoped(Effect.gen(function*() {
        const fresh = yield* makeTempDirectoryScoped("expand-remote-missing-")
        const freshContext = makeAppContext(path, { homeDir: fresh, cwd: fresh, dataDir: fresh })
        return yield* readRemoteConnection.pipe(
          Effect.provide(Layer.mergeAll(ProcessServices.layer, Layer.succeed(AppContext, freshContext)))
        )
      }))
      expect(missing).toEqual({ _tag: "local" })
    })).pipe(Effect.provide(NodeServices.layer)))

  it.live("reuses the session epoch machinery in remote mode with zero spawns", () =>
    Effect.scoped(Effect.gen(function*() {
      const path = yield* Path.Path
      const dir = yield* makeTempDirectoryScoped("expand-remote-session-")
      const context = makeAppContext(path, { homeDir: dir, cwd: dir, dataDir: dir })
      const base = Layer.mergeAll(ProcessServices.layer, Layer.succeed(AppContext, context))
      const { endpoint } = yield* acquireClient(nodeAdapter).pipe(Effect.provide(base))
      let spawns = 0
      const counting = {
        protocolLayer: nodeAdapter.protocolLayer,
        spawnBackend: () => Effect.die("remote spawnBackend must not be called") as unknown as Effect.Effect<void>
      }
      const remote = { _tag: "remote", url: endpoint.url, token: endpoint.token } as const
      const invalid = yield* acquireClient(counting, { _tag: "remote", url: "", token: "t" } as const).pipe(
        Effect.provide(base),
        Effect.exit
      )
      expect(invalid._tag).toBe("Failure")
      expect(spawns).toBe(0)
      const sessionContext = yield* Layer.build(ClientSessionLayer(counting, remote).pipe(Layer.provide(base)))
      const session = yield* ClientSession.pipe(Effect.provide(sessionContext))
      const api = yield* session.current
      expect(yield* api.Health()).toBe("ok")
      expect(spawns).toBe(0)
    })).pipe(Effect.provide(NodeServices.layer)))

  it.live("resubscribes to project events from sequence in remote mode", () =>
    Effect.scoped(Effect.gen(function*() {
      const path = yield* Path.Path
      const dir = yield* makeTempDirectoryScoped("expand-remote-events-")
      const context = makeAppContext(path, { homeDir: dir, cwd: dir, dataDir: dir })
      const base = Layer.mergeAll(ProcessServices.layer, Layer.succeed(AppContext, context))
      const { endpoint } = yield* acquireClient(nodeAdapter).pipe(Effect.provide(base))
      let spawns = 0
      const counting = {
        protocolLayer: nodeAdapter.protocolLayer,
        spawnBackend: () => Effect.die("remote spawnBackend must not be called") as unknown as Effect.Effect<void>
      }
      const remote = { _tag: "remote", url: endpoint.url, token: endpoint.token } as const
      const sessionContext = yield* Layer.build(ClientSessionLayer(counting, remote).pipe(Layer.provide(base)))
      const session = yield* ClientSession.pipe(Effect.provide(sessionContext))
      const api = yield* session.current
      const before = yield* api.ProjectList({})
      yield* api.ProjectCreate({ name: "remote-seq-probe", ensure: true })
      const after = yield* api.ProjectList({})
      expect(after.seq > before.seq).toBe(true)
      const head = yield* api.Events({ fromSeq: before.seq }).pipe(Stream.runHead)
      const first = Option.getOrThrow(head)
      expect(first.seq > before.seq).toBe(true)
      expect(spawns).toBe(0)
    })).pipe(Effect.provide(NodeServices.layer)))

  it.live("kills the connection and resubscribes events on the second epoch with zero spawns", () =>
    Effect.scoped(Effect.gen(function*() {
      const path = yield* Path.Path
      const dir = yield* makeTempDirectoryScoped("expand-remote-kill-")
      const context = makeAppContext(path, { homeDir: dir, cwd: dir, dataDir: dir })
      const base = Layer.mergeAll(ProcessServices.layer, Layer.succeed(AppContext, context))
      const { endpoint } = yield* acquireClient(nodeAdapter).pipe(Effect.provide(base))
      let spawns = 0
      let killHook: Effect.Effect<void> | undefined
      const counting = {
        protocolLayer: (url: string) =>
          nodeAdapter.protocolLayer(url).pipe(
            Layer.tap(() =>
              RpcClient.ConnectionHooks.pipe(
                Effect.tap((hooks) =>
                  Effect.sync(() => {
                    killHook = hooks.onDisconnect
                  })
                )
              )
            )
          ) as ReturnType<typeof nodeAdapter.protocolLayer>,
        spawnBackend: () => Effect.die("remote spawnBackend must not be called") as unknown as Effect.Effect<void>
      }
      const remote = { _tag: "remote", url: endpoint.url, token: endpoint.token } as const
      const sessionContext = yield* Layer.build(ClientSessionLayer(counting, remote).pipe(Layer.provide(base)))
      const session = yield* ClientSession.pipe(Effect.provide(sessionContext))
      const firstEpoch = yield* session.current
      const before = yield* firstEpoch.ProjectList({})
      yield* firstEpoch.ProjectCreate({ name: "remote-kill-probe", ensure: true })
      const firstHead = yield* firstEpoch.Events({ fromSeq: before.seq }).pipe(Stream.runHead)
      const lastSeq = Option.getOrThrow(firstHead).seq
      expect(lastSeq > before.seq).toBe(true)
      if (killHook === undefined) return yield* Effect.die("disconnect hook not captured")
      yield* killHook
      const secondEpoch = yield* session.current
      expect(yield* secondEpoch.Health()).toBe("ok")
      yield* secondEpoch.ProjectCreate({ name: "remote-kill-probe-2", ensure: true })
      const secondHead = yield* secondEpoch.Events({ fromSeq: lastSeq }).pipe(Stream.runHead)
      const resumed = Option.getOrThrow(secondHead)
      expect(resumed.seq > lastSeq).toBe(true)
      expect(spawns).toBe(0)
    })).pipe(Effect.provide(NodeServices.layer)))

  it.live("rejects invalid remote connection input", () =>
    Effect.gen(function*() {
      const emptyUrl = yield* testRemoteConnection(nodeAdapter, { _tag: "remote", url: "", token: "t" } as const).pipe(Effect.flip)
      expect(emptyUrl.field).toBe("url")
      const emptyToken = yield* testRemoteConnection(nodeAdapter, { _tag: "remote", url: "ws://127.0.0.1:1/rpc", token: "" } as const).pipe(Effect.flip)
      expect(emptyToken.field).toBe("token")
      const whitespaceToken = yield* testRemoteConnection(nodeAdapter, { _tag: "remote", url: "ws://127.0.0.1:1/rpc", token: "   " } as const).pipe(Effect.flip)
      expect(whitespaceToken.field).toBe("token")
      const unsupported = yield* testRemoteConnection(nodeAdapter, { _tag: "remote", url: "ftp://example.com/rpc", token: "t" } as const).pipe(Effect.flip)
      expect(unsupported.field).toBe("url")
    }))
})
