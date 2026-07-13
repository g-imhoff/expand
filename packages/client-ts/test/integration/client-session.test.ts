import { describe, expect, it, vi } from "vitest"
import { Deferred, Effect, Exit, Fiber, Layer, Result, Scope, Stream, SubscriptionRef } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { RpcClient, RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { createServer } from "node:http"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AppContext, makeAppContext } from "@expand/contracts/app-context"
import { PROTOCOL_VERSION } from "@expand/contracts/endpoint"
import { ExpandRpcs } from "@expand/contracts/rpc"
import type { RuntimeAdapter } from "../../adapter"
import { makeNodeAdapter } from "../../adapters/node"
import { ClientSession, ClientSessionLayer, type ClientSessionApi } from "../../client-session"
import { BackendUnavailable } from "../../errors"

const acquireControl = vi.hoisted(() => ({
  pause: undefined as (() => Promise<void>) | undefined
}))

const nodeAdapter = makeNodeAdapter({ backendCommand: [] })

vi.mock("../../rpc-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../rpc-client")>()
  const { Effect } = await import("effect")
  return {
    ...actual,
    acquireClient: (adapter: Parameters<typeof actual.acquireClient>[0]) =>
      actual.acquireClient(adapter).pipe(
        Effect.tap(() =>
          Effect.promise(() => acquireControl.pause?.() ?? Promise.resolve())
        )
      )
  }
})

interface ScriptedBackend {
  readonly adapter: RuntimeAdapter
  readonly appContext: ReturnType<typeof makeAppContext>
  readonly disconnect: Effect.Effect<void>
  readonly dispose: Effect.Effect<void>
  readonly blockNextSpawn: () => void
  readonly reconnectCount: () => number
  readonly retryStarted: Effect.Effect<void>
  readonly retryInterrupted: Effect.Effect<void>
  readonly disconnectHook: Effect.Effect<void>
}

const makeHandlers = () =>
  ExpandRpcs.toLayer({
    Health: () => Effect.succeed("ok"),
    ProjectCreate: () => Effect.die("unused"),
    ProjectRename: () => Effect.die("unused"),
    ProjectChangeDirectory: () => Effect.die("unused"),
    ProjectArchive: () => Effect.die("unused"),
    ProjectRestore: () => Effect.die("unused"),
    ProjectSetMetadata: () => Effect.die("unused"),
    ProjectDelete: () => Effect.die("unused"),
    ProjectList: () => Effect.succeed({ projects: [], seq: 0 }),
    Connect: () => Stream.make(true).pipe(Stream.concat(Stream.never)),
    Events: () => Stream.never
  })

const makeScriptedBackend = async (): Promise<ScriptedBackend> => {
  const dir = mkdtempSync(join(tmpdir(), "expand-client-session-"))
  const appContext = makeAppContext(dir)
  const retryStarted = Deferred.makeUnsafe<void>()
  const retryInterrupted = Deferred.makeUnsafe<void>()
  let currentScope: Scope.Closeable | undefined
  let reconnects = 0
  let blockSpawn = false
  let currentDisconnectHook: Effect.Effect<void> = Effect.die("connection hook not installed")

  const startServer = Effect.gen(function* () {
    const rpc = RpcServer.layer(ExpandRpcs).pipe(
      Layer.provide(makeHandlers()),
      Layer.provide(RpcServer.layerProtocolWebsocket({ path: "/rpc" })),
      Layer.provide(RpcSerialization.layerNdjson)
    )
    const node = NodeHttpServer.layer(createServer, { port: 0, gracefulShutdownTimeout: "500 millis" })
    const serverLayer = Layer.mergeAll(HttpRouter.serve(rpc, { disableLogger: true }), node).pipe(
      Layer.provide(node)
    )
    const serverScope = yield* Scope.make()
    const transport = yield* Layer.build(serverLayer).pipe(Scope.provide(serverScope))
    const address = yield* HttpServer.HttpServer.pipe(
      Effect.map((server) => server.address),
      Effect.provide(transport)
    )
    const port = address._tag === "TcpAddress" ? address.port : 0
    currentScope = serverScope
    yield* Effect.sync(() =>
      writeFileSync(
        appContext.paths.endpointFile,
        JSON.stringify({
          url: `ws://127.0.0.1:${port}/rpc`,
          token: "client-session-test",
          pid: process.pid,
          protocolVersion: PROTOCOL_VERSION
        })
      )
    )
  })

  const closeCurrent = Effect.gen(function* () {
    const scope = currentScope
    currentScope = undefined
    yield* Effect.sync(() => rmSync(appContext.paths.endpointFile, { force: true }))
    if (scope !== undefined) yield* Scope.close(scope, Exit.void).pipe(Effect.exit)
  })

  const adapter: RuntimeAdapter = {
    protocolLayer: (url) =>
      nodeAdapter.protocolLayer(url).pipe(
        Layer.tap(() =>
          RpcClient.ConnectionHooks.pipe(
            Effect.tap((hooks) =>
              Effect.sync(() => {
                currentDisconnectHook = hooks.onDisconnect
              })
            )
          )
        )
      ) as Layer.Layer<RpcClient.Protocol>,
    spawnBackend: () =>
      Effect.sync(() => ++reconnects).pipe(
        Effect.flatMap(() =>
          blockSpawn
            ? Deferred.succeed(retryStarted, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() => Deferred.succeed(retryInterrupted, undefined))
              )
            : startServer.pipe(Effect.orDie)
        )
      )
  }

  await Effect.runPromise(startServer)

  return {
    adapter,
    appContext,
    disconnect: closeCurrent,
    dispose: closeCurrent.pipe(
      Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true })))
    ),
    blockNextSpawn: () => {
      blockSpawn = true
    },
    reconnectCount: () => reconnects,
    retryStarted: Deferred.await(retryStarted),
    retryInterrupted: Deferred.await(retryInterrupted),
    disconnectHook: Effect.suspend(() => currentDisconnectHook)
  }
}

const openSession = async (
  backend: ScriptedBackend,
  adapter: RuntimeAdapter = backend.adapter
): Promise<{ readonly session: ClientSessionApi; readonly scope: Scope.Closeable }> => {
  const scope = await Effect.runPromise(Scope.make())
  const context = await Effect.runPromise(
    Layer.build(
      ClientSessionLayer(adapter).pipe(
        Layer.provide(NodeServices.layer),
        Layer.provide(Layer.succeed(AppContext, backend.appContext))
      )
    ).pipe(Scope.provide(scope))
  )
  const session = await Effect.runPromise(ClientSession.pipe(Effect.provide(context)))
  return { session, scope }
}

const runInternalAcquireRetryScenario = async () => {
  const backend = await makeScriptedBackend()
  const endpointFile = backend.appContext.paths.endpointFile
  const healthyEndpoint = readFileSync(endpointFile, "utf8")
  const attemptedUrls: Array<string> = []
  writeFileSync(
    endpointFile,
    JSON.stringify({
      url: "ws://127.0.0.1:9/rpc",
      token: "stale",
      pid: process.pid,
      protocolVersion: PROTOCOL_VERSION
    })
  )
  const adapter: RuntimeAdapter = {
    protocolLayer: (url) => {
      attemptedUrls.push(url)
      return backend.adapter.protocolLayer(url)
    },
    spawnBackend: () =>
      Effect.sync(() => {
        writeFileSync(endpointFile, healthyEndpoint)
      })
  }

  try {
    return await Effect.runPromise(
      Effect.gen(function* () {
        const context = yield* Layer.build(
          ClientSessionLayer(adapter).pipe(
            Layer.provide(NodeServices.layer),
            Layer.provide(Layer.succeed(AppContext, backend.appContext))
          )
        )
        const session = yield* ClientSession.pipe(Effect.provide(context))
        const client = yield* session.current
        return {
          attemptedUrls,
          health: yield* client.Health(),
          status: yield* SubscriptionRef.get(session.status)
        }
      }).pipe(Effect.scoped)
    )
  } finally {
    await Effect.runPromise(backend.dispose)
  }
}

const closeSession = (scope: Scope.Closeable): Promise<void> =>
  Effect.runPromise(Scope.close(scope, Exit.void))

let reconnectCount = (): number => 0

const runReconnectScenario = async <A>(
  observe: (session: ClientSessionApi) => Effect.Effect<A>
): Promise<A> => {
  const backend = await makeScriptedBackend()
  const { session, scope } = await openSession(backend)
  reconnectCount = backend.reconnectCount
  try {
    return await Effect.runPromise(
      Effect.gen(function* () {
        const observer = yield* Effect.forkChild(observe(session))
        yield* Effect.yieldNow
        yield* backend.disconnect
        return yield* Fiber.join(observer)
      })
    )
  } finally {
    reconnectCount = () => 0
    await closeSession(scope)
    await Effect.runPromise(backend.dispose)
  }
}

const runDisconnectOrderingScenario = async (): Promise<{
  readonly currentResolvedWhileReconnecting: boolean
}> => {
  const backend = await makeScriptedBackend()
  const { session, scope } = await openSession(backend)
  try {
    const probe = Effect.runFork(
      SubscriptionRef.changes(session.status).pipe(
        Stream.filter((status) => status === "reconnecting"),
        Stream.take(1),
        Stream.runDrain,
        Effect.andThen(
          session.current.pipe(
            Effect.as(true),
            Effect.timeoutOrElse({
              duration: "100 millis",
              orElse: () => Effect.succeed(false)
            })
          )
        )
      )
    )
    await Effect.runPromise(Effect.yieldNow)
    await Effect.runPromise(backend.disconnect)
    return { currentResolvedWhileReconnecting: await Effect.runPromise(Fiber.join(probe)) }
  } finally {
    await closeSession(scope)
    await Effect.runPromise(backend.dispose)
  }
}

const runAcquireDisconnectRaceScenario = async (): Promise<"published" | "retrying"> => {
  const backend = await makeScriptedBackend()
  const { session, scope } = await openSession(backend)
  let resumeAcquire = (): void => {}
  let acquisitionReached = (): void => {}
  const acquirePaused = new Promise<void>((resolve) => {
    acquisitionReached = resolve
  })
  const acquireReleased = new Promise<void>((resolve) => {
    resumeAcquire = resolve
  })
  acquireControl.pause = () => {
    acquireControl.pause = undefined
    acquisitionReached()
    return acquireReleased
  }

  try {
    await Effect.runPromise(backend.disconnect)
    await acquirePaused
    backend.blockNextSpawn()
    const publication = Effect.runFork(
      SubscriptionRef.changes(session.status).pipe(
        Stream.filter((status) => status === "connected"),
        Stream.take(1),
        Stream.runDrain,
        Effect.as("published" as const)
      )
    )
    await Effect.runPromise(backend.disconnectHook)
    await Effect.runPromise(backend.disconnect)
    resumeAcquire()
    return await Effect.runPromise(
      Effect.race(
        Fiber.join(publication),
        backend.retryStarted.pipe(Effect.as("retrying" as const))
      ).pipe(
        Effect.timeoutOrElse({
          duration: "5 seconds",
          orElse: () => Effect.fail(new Error("session neither published nor retried"))
        })
      )
    )
  } finally {
    acquireControl.pause = undefined
    resumeAcquire()
    await closeSession(scope)
    await Effect.runPromise(backend.dispose)
  }
}

const runCurrentWaitScenario = async () => {
  const backend = await makeScriptedBackend()
  const { session, scope } = await openSession(backend)
  try {
    const first = await Effect.runPromise(session.current)
    const reconnecting = Effect.runFork(
      SubscriptionRef.changes(session.status).pipe(
        Stream.filter((status) => status === "reconnecting"),
        Stream.take(1),
        Stream.runDrain
      )
    )
    await Effect.runPromise(Effect.yieldNow)
    await Effect.runPromise(backend.disconnect)
    await Effect.runPromise(Fiber.join(reconnecting))
    const second = await Effect.runPromise(session.current)
    const health = await Effect.runPromise(second.Health())
    return { first, second, health }
  } finally {
    await closeSession(scope)
    await Effect.runPromise(backend.dispose)
  }
}

const runScopeClosureScenario = async (): Promise<{
  readonly status: string
  readonly retryFiberInterrupted: boolean
}> => {
  const backend = await makeScriptedBackend()
  backend.blockNextSpawn()
  const { session, scope } = await openSession(backend)
  let closed = false
  try {
    await Effect.runPromise(backend.disconnect)
    await Effect.runPromise(
      backend.retryStarted.pipe(
        Effect.timeoutOrElse({
          duration: "5 seconds",
          orElse: () => Effect.fail(new Error("retry did not start"))
        })
      )
    )
    await closeSession(scope)
    closed = true
    const status = await Effect.runPromise(SubscriptionRef.get(session.status))
    const retryFiberInterrupted = await Effect.runPromise(
      backend.retryInterrupted.pipe(
        Effect.as(true),
        Effect.timeoutOrElse({
          duration: "1 second",
          orElse: () => Effect.succeed(false)
        })
      )
    )
    return { status, retryFiberInterrupted }
  } finally {
    if (!closed) await closeSession(scope)
    await Effect.runPromise(backend.dispose)
  }
}

describe("ClientSession", () => {
  it("fails the layer with BackendUnavailable when first acquisition fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "expand-client-session-failure-"))
    const failingAdapter: RuntimeAdapter = {
      protocolLayer: nodeAdapter.protocolLayer,
      spawnBackend: () => Effect.fail(new BackendUnavailable({ reason: "expected" }))
    }
    try {
      const result = await Effect.runPromise(
        Effect.scoped(
          Layer.build(
            ClientSessionLayer(failingAdapter).pipe(
              Layer.provide(NodeServices.layer),
              Layer.provide(Layer.succeed(AppContext, makeAppContext(dir)))
            )
          )
        ).pipe(Effect.result)
      )
      expect(Result.isFailure(result)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("publishes connected, reconnecting, connected across reacquisition", async () => {
    const observed = await runReconnectScenario((session) =>
      SubscriptionRef.changes(session.status).pipe(
        Stream.takeUntil((status) => status === "connected" && reconnectCount() === 1),
        Stream.runCollect
      )
    )
    expect(Array.from(observed)).toEqual(["connected", "reconnecting", "connected"])
  })

  it("invalidates the stale epoch before publishing reconnecting", async () => {
    const result = await runDisconnectOrderingScenario()
    expect(result.currentResolvedWhileReconnecting).toBe(false)
  })

  it("does not publish an epoch that disconnects after acquisition", async () => {
    expect(await runAcquireDisconnectRaceScenario()).toBe("retrying")
  })

  it(
    "publishes a healthy internal acquire retry after a stale transport disconnects",
    async () => {
      const result = await runInternalAcquireRetryScenario()
      expect(result.attemptedUrls).toHaveLength(2)
      expect(result.attemptedUrls[0]).toContain("127.0.0.1:9")
      expect(result.health).toBe("ok")
      expect(result.status).toBe("connected")
    },
    10000
  )

  it("current waits for and returns the next epoch", async () => {
    const result = await runCurrentWaitScenario()
    expect(result.second).not.toBe(result.first)
    expect(result.health).toBe("ok")
  })

  it("scope closure publishes disconnected and interrupts retry", async () => {
    const result = await runScopeClosureScenario()
    expect(result.status).toBe("disconnected")
    expect(result.retryFiberInterrupted).toBe(true)
  })
})
