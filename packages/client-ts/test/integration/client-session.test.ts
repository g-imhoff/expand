import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Cause, Clock, Deferred, Duration, Effect, Exit, Fiber, FileSystem, Layer, Path, PlatformError, Queue, Result, Schema, Scope, Stream, SubscriptionRef } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { RpcClient, RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { describe, expect } from "vitest"
import { makeTempDirectoryScoped } from "../../../../test/support/effect-files"
import { makeNodeAdapter, ProcessServices } from "../../adapters/node"
import { AppContext, makeAppContext } from "@expand/contracts/app-context"
import { EndpointFromJson } from "@expand/contracts/endpoint"
import { PROTOCOL_VERSION } from "@expand/contracts/rpc/version"
import { ProcessControl } from "@expand/contracts/process-control"
import { ExpandRpcs } from "@expand/contracts/rpc"
import type { RuntimeAdapter } from "../../adapter"
import { ClientSession, ClientSessionLayer, type ClientSessionApi } from "../../client-session"
import { BackendUnavailable } from "../../errors"

const acquireControl: { pause: Effect.Effect<void> | undefined } = {
  pause: undefined
}

const awaitAcquirePause = Effect.sync(() => {
  const pause = acquireControl.pause
  acquireControl.pause = undefined
  return pause
}).pipe(Effect.flatMap((pause) => pause ?? Effect.void))

const nodeAdapter = makeNodeAdapter({ backendCommand: Effect.succeed([]) })

interface ScriptedBackend {
  readonly adapter: RuntimeAdapter
  readonly appContext: ReturnType<typeof AppContext.make>
  readonly disconnect: Effect.Effect<void, BackendUnavailable>
  readonly blockNextSpawn: () => void
  readonly reconnectCount: () => number
  readonly retryStarted: Effect.Effect<void>
  readonly retryInterrupted: Effect.Effect<void>
  readonly disconnectHook: Effect.Effect<void>
  readonly hasCurrentServer: () => boolean
  readonly setEndpointRemovalFailure: (error: BackendUnavailable) => void
  readonly setServerCloseDefect: (defect: unknown) => void
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

const makeScriptedBackend = Effect.fn("ClientSessionTest.makeScriptedBackend")(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const processControl = yield* ProcessControl
  const dir = yield* makeTempDirectoryScoped("expand-client-session-")
  const appContext = makeTestAppContext(dir, path)
  const parentScope = yield* Scope.Scope
  const serverOwnerScope = yield* Scope.fork(parentScope)
  const retryStarted = yield* Deferred.make<void>()
  const retryInterrupted = yield* Deferred.make<void>()
  let currentServer: { readonly scope: Scope.Closeable; readonly clock: Clock.Clock } | undefined
  let reconnects = 0
  let blockSpawn = false
  let endpointRemovalFailure: BackendUnavailable | undefined
  let serverCloseDefect: unknown | undefined
  let currentDisconnectHook: Effect.Effect<void> = Effect.die("connection hook not installed")

  const closeCurrent = Effect.uninterruptible(Effect.gen(function*() {
    const server = currentServer
    currentServer = undefined
    const endpointRemoval = yield* fs.remove(appContext.paths.endpointFile, { force: true }).pipe(
      Effect.mapError((cause) => endpointRemovalFailure ?? new BackendUnavailable({
        reason: `failed to remove scripted endpoint: ${String(cause)}`
      })),
      Effect.exit
    )
    const serverClosure = server === undefined
      ? Exit.void
      : yield* Scope.close(server.scope, Exit.void).pipe(
          Effect.provideService(Clock.Clock, server.clock),
          Effect.catchCause((cause) => Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.failCause(cause)),
          Effect.exit
        )
    if (Exit.isFailure(endpointRemoval) && Exit.isFailure(serverClosure)) {
      return yield* Effect.failCause(Cause.combine(endpointRemoval.cause, serverClosure.cause))
    }
    if (Exit.isFailure(endpointRemoval)) return yield* Effect.failCause(endpointRemoval.cause)
    if (Exit.isFailure(serverClosure)) return yield* Effect.failCause(serverClosure.cause)
  }))

  yield* Effect.addFinalizer(() => closeCurrent.pipe(
    Effect.catchCause((cause) => Effect.failCause(Cause.fromReasons<never>(
      cause.reasons.map((reason) => Cause.isFailReason(reason)
        ? Cause.makeDieReason(reason.error)
        : reason)
    )))
  ))

  const startServer = Effect.gen(function*() {
    const rpc = RpcServer.layer(ExpandRpcs).pipe(
      Layer.provide(makeHandlers()),
      Layer.provide(RpcServer.layerProtocolWebsocket({ path: "/rpc" })),
      Layer.provide(RpcSerialization.layerNdjson)
    )
    const clock = yield* Clock.Clock
    const serverClock = Clock.Clock.of({
      currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
      currentTimeMillis: clock.currentTimeMillis,
      currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
      currentTimeNanos: clock.currentTimeNanos,
      sleep: (duration) => clock.sleep(Duration.min(duration, Duration.millis(500)))
    })
    const node = NodeHttpServer.layerTest
    const serverLayer = HttpRouter.serve(rpc, { disableLogger: true }).pipe(
      Layer.provideMerge(node)
    )
    const serverScope = yield* Scope.fork(serverOwnerScope)
    yield* Scope.addFinalizer(serverScope, Effect.suspend(() => serverCloseDefect === undefined
      ? Effect.void
      : Effect.die(serverCloseDefect)))
    yield* Effect.gen(function*() {
      const transport = yield* Layer.build(serverLayer).pipe(Scope.provide(serverScope))
      const address = yield* HttpServer.HttpServer.pipe(
        Effect.map((server) => server.address),
        Effect.provide(transport)
      )
      const port = address._tag === "TcpAddress" ? address.port : 0
      const endpoint = yield* Schema.encodeEffect(EndpointFromJson)({
        url: `ws://127.0.0.1:${port}/rpc`,
        token: "client-session-test",
        pid: processControl.currentPid,
        protocolVersion: PROTOCOL_VERSION
      })
      yield* fs.writeFileString(appContext.paths.endpointFile, endpoint)
      currentServer = { scope: serverScope, clock: serverClock }
    }).pipe(
      Effect.onExit((exit) => Exit.isFailure(exit)
        ? Scope.close(serverScope, exit).pipe(Effect.provideService(Clock.Clock, serverClock))
        : Effect.void)
    )
  })

  const adapter: RuntimeAdapter = {
    protocolLayer: (url) =>
      nodeAdapter.protocolLayer(url).pipe(
        Layer.tap(() => RpcClient.ConnectionHooks.pipe(
          Effect.tap((hooks) => Effect.sync(() => {
            currentDisconnectHook = hooks.onDisconnect
          })),
          Effect.andThen(awaitAcquirePause)
        ))
      ) as Layer.Layer<RpcClient.Protocol>,
    spawnBackend: () => Effect.sync(() => ++reconnects).pipe(
      Effect.flatMap(() => blockSpawn
        ? Deferred.succeed(retryStarted, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(retryInterrupted, undefined))
          )
        : startServer.pipe(
            Effect.mapError((cause) => new BackendUnavailable({
              reason: `failed to start scripted backend: ${String(cause)}`
            }))
          ))
    )
  }

  yield* startServer

  return {
    adapter,
    appContext,
    disconnect: closeCurrent,
    blockNextSpawn: () => {
      blockSpawn = true
    },
    reconnectCount: () => reconnects,
    retryStarted: Deferred.await(retryStarted),
    retryInterrupted: Deferred.await(retryInterrupted),
    disconnectHook: Effect.suspend(() => currentDisconnectHook),
    hasCurrentServer: () => currentServer !== undefined,
    setEndpointRemovalFailure: (error: BackendUnavailable) => {
      endpointRemovalFailure = error
    },
    setServerCloseDefect: (defect: unknown) => {
      serverCloseDefect = defect
    }
  }
})

const openSession = Effect.fn("ClientSessionTest.openSession")(function*(
  backend: ScriptedBackend,
  adapter: RuntimeAdapter = backend.adapter
) {
  const parentScope = yield* Scope.Scope
  const scope = yield* Scope.fork(parentScope)
  return yield* Effect.gen(function*() {
    const context = yield* Layer.build(
      ClientSessionLayer(adapter).pipe(
        Layer.provide(ProcessServices.layer),
        Layer.provide(Layer.succeed(AppContext, backend.appContext))
      )
    ).pipe(Scope.provide(scope))
    const session = yield* ClientSession.pipe(Effect.provide(context))
    return { session, scope }
  }).pipe(
    Effect.onExit((exit) => Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void)
  )
})

let reconnectCount = (): number => 0

const runReconnectScenario = <A>(observe: (session: ClientSessionApi) => Effect.Effect<A>) =>
  Effect.scoped(Effect.gen(function*() {
    const backend = yield* makeScriptedBackend()
    const { session, scope } = yield* openSession(backend)
    reconnectCount = backend.reconnectCount
    yield* Effect.addFinalizer(() => Effect.sync(() => {
      reconnectCount = () => 0
    }).pipe(Effect.andThen(Scope.close(scope, Exit.void))))
    const observer = yield* Effect.forkChild(observe(session))
    yield* Effect.yieldNow
    yield* backend.disconnect
    return yield* Fiber.join(observer)
  }))

const runDisconnectOrderingScenario = () =>
  Effect.scoped(Effect.gen(function*() {
    const backend = yield* makeScriptedBackend()
    const { session, scope } = yield* openSession(backend)
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
    const probe = yield* SubscriptionRef.changes(session.status).pipe(
      Stream.filter((status) => status === "reconnecting"),
      Stream.take(1),
      Stream.runDrain,
      Effect.andThen(session.current.pipe(
        Effect.as(true),
        Effect.timeoutOrElse({ duration: "100 millis", orElse: () => Effect.succeed(false) })
      )),
      Effect.forkChild
    )
    yield* Effect.yieldNow
    yield* backend.disconnect
    return { currentResolvedWhileReconnecting: yield* Fiber.join(probe) }
  }))

const runAcquireDisconnectRaceScenario = () =>
  Effect.scoped(Effect.gen(function*() {
    const backend = yield* makeScriptedBackend()
    const { session, scope } = yield* openSession(backend)
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
    const acquirePaused = yield* Queue.unbounded<void>()
    const acquireReleased = yield* Queue.unbounded<void>()
    acquireControl.pause = Queue.offer(acquirePaused, undefined).pipe(
      Effect.andThen(Queue.take(acquireReleased))
    )
    yield* Effect.addFinalizer(() => Effect.sync(() => {
      acquireControl.pause = undefined
    }).pipe(Effect.andThen(Queue.offer(acquireReleased, undefined))))
    yield* backend.disconnect
    yield* Queue.take(acquirePaused)
    backend.blockNextSpawn()
    const publication = yield* SubscriptionRef.changes(session.status).pipe(
      Stream.filter((status) => status === "connected"),
      Stream.take(1),
      Stream.runDrain,
      Effect.as("published" as const),
      Effect.forkChild
    )
    yield* backend.disconnectHook
    yield* backend.disconnect
    yield* Queue.offer(acquireReleased, undefined)
    return yield* Effect.race(
      Fiber.join(publication),
      backend.retryStarted.pipe(Effect.as("retrying" as const))
    ).pipe(
      Effect.timeoutOrElse({
        duration: "5 seconds",
        orElse: () => Effect.fail("session neither published nor retried")
      })
    )
  }))

const runInterruptedAcquireScopeScenario = () =>
  Effect.scoped(Effect.gen(function*() {
    const backend = yield* makeScriptedBackend()
    const sessionAcquired = yield* Queue.unbounded<void>()
    const acquireScopeClosed = yield* Queue.unbounded<void>()
    const observedAdapter: RuntimeAdapter = {
      protocolLayer: (url) => backend.adapter.protocolLayer(url).pipe(
        Layer.tap(() => Effect.addFinalizer(() => Queue.offer(acquireScopeClosed, undefined)))
      ),
      spawnBackend: backend.adapter.spawnBackend
    }
    const owner = yield* Effect.scoped(Effect.gen(function*() {
      yield* openSession(backend, observedAdapter)
      yield* Queue.offer(sessionAcquired, undefined)
      return yield* Effect.never
    })).pipe(Effect.forkChild)
    yield* Queue.take(sessionAcquired)
    yield* Fiber.interrupt(owner)
    return yield* Queue.take(acquireScopeClosed).pipe(
      Effect.as(true),
      Effect.timeoutOrElse({ duration: "1 second", orElse: () => Effect.succeed(false) })
    )
  }))

const runOneShotAcquirePauseScenario = () =>
  Effect.scoped(Effect.gen(function*() {
    const acquirePaused = yield* Queue.unbounded<void>()
    const acquireReleased = yield* Queue.unbounded<void>()
    acquireControl.pause = Queue.offer(acquirePaused, undefined).pipe(
      Effect.andThen(Queue.take(acquireReleased))
    )
    yield* Effect.addFinalizer(() => Effect.sync(() => {
      acquireControl.pause = undefined
    }).pipe(Effect.andThen(Queue.offer(acquireReleased, undefined))))
    const first = yield* awaitAcquirePause.pipe(Effect.forkChild)
    yield* Queue.take(acquirePaused)
    yield* Queue.offer(acquireReleased, undefined)
    yield* Fiber.join(first)
    return yield* awaitAcquirePause.pipe(
      Effect.as(true),
      Effect.timeoutOrElse({ duration: "1 second", orElse: () => Effect.succeed(false) })
    )
  }))

const makeEndpointRemovalFailingFileSystem = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  let failurePending = true
  const failure = PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method: "remove",
    pathOrDescriptor: "scripted endpoint"
  })
  return FileSystem.FileSystem.of({
    ...fs,
    remove: (target, options) => failurePending
      ? Effect.sync(() => {
          failurePending = false
        }).pipe(Effect.andThen(Effect.fail(failure)))
      : fs.remove(target, options)
  })
})

const runDirectCleanupFailureScenario = Effect.gen(function*() {
  const failingFs = yield* makeEndpointRemovalFailingFileSystem
  const closeDefect = new Error("scripted server close defect")
  let backend: ScriptedBackend | undefined
  let disconnectExit: Exit.Exit<void, BackendUnavailable> | undefined
  const ownerExit = yield* Effect.scoped(Effect.gen(function*() {
    backend = yield* makeScriptedBackend()
    backend.setServerCloseDefect(closeDefect)
    disconnectExit = yield* backend.disconnect.pipe(Effect.exit)
  })).pipe(
    Effect.provideService(FileSystem.FileSystem, failingFs),
    Effect.exit
  )
  if (backend === undefined || disconnectExit === undefined) return yield* Effect.die("cleanup scenario did not start")
  return { backend, closeDefect, disconnectExit, ownerExit }
})

const runFinalizerCleanupFailureScenario = Effect.gen(function*() {
  const failingFs = yield* makeEndpointRemovalFailingFileSystem
  const endpointRemovalFailure = new BackendUnavailable({ reason: "scripted endpoint removal failure" })
  const closeDefect = new Error("scripted finalizer server close defect")
  let backend: ScriptedBackend | undefined
  const ownerExit = yield* Effect.scoped(Effect.gen(function*() {
    backend = yield* makeScriptedBackend()
    backend.setEndpointRemovalFailure(endpointRemovalFailure)
    backend.setServerCloseDefect(closeDefect)
  })).pipe(
    Effect.provideService(FileSystem.FileSystem, failingFs),
    Effect.exit
  )
  if (backend === undefined) return yield* Effect.die("finalizer scenario did not start")
  return { backend, closeDefect, endpointRemovalFailure, ownerExit }
})

const runInternalAcquireRetryScenario = () =>
  Effect.scoped(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const backend = yield* makeScriptedBackend()
    const endpointFile = backend.appContext.paths.endpointFile
    const healthyEndpoint = yield* fs.readFileString(endpointFile)
    const attemptedUrls: Array<string> = []
    const staleEndpoint = yield* Schema.encodeEffect(EndpointFromJson)({
      url: "ws://127.0.0.1:9/rpc",
      token: "stale",
      pid: (yield* ProcessControl).currentPid,
      protocolVersion: PROTOCOL_VERSION
    })
    yield* fs.writeFileString(endpointFile, staleEndpoint)
    const adapter: RuntimeAdapter = {
      protocolLayer: (url) => {
        attemptedUrls.push(url)
        return backend.adapter.protocolLayer(url)
      },
      spawnBackend: () => fs.writeFileString(endpointFile, healthyEndpoint).pipe(
        Effect.mapError((cause) => new BackendUnavailable({
          reason: `failed to restore scripted endpoint: ${String(cause)}`
        }))
      )
    }
    const context = yield* Layer.build(
      ClientSessionLayer(adapter).pipe(
        Layer.provide(ProcessServices.layer),
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
  }))

const runCurrentWaitScenario = () =>
  Effect.scoped(Effect.gen(function*() {
    const backend = yield* makeScriptedBackend()
    const { session, scope } = yield* openSession(backend)
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
    const first = yield* session.current
    const reconnecting = yield* SubscriptionRef.changes(session.status).pipe(
      Stream.filter((status) => status === "reconnecting"),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkChild
    )
    yield* Effect.yieldNow
    yield* backend.disconnect
    yield* Fiber.join(reconnecting)
    const second = yield* session.current
    const health = yield* second.Health()
    return { first, second, health }
  }))

const runScopeClosureScenario = () =>
  Effect.scoped(Effect.gen(function*() {
    const backend = yield* makeScriptedBackend()
    backend.blockNextSpawn()
    const { session, scope } = yield* openSession(backend)
    yield* backend.disconnect
    yield* backend.retryStarted.pipe(
      Effect.timeoutOrElse({
        duration: "5 seconds",
        orElse: () => Effect.fail("retry did not start")
      })
    )
    yield* Scope.close(scope, Exit.void)
    const status = yield* SubscriptionRef.get(session.status)
    const retryFiberInterrupted = yield* backend.retryInterrupted.pipe(
      Effect.as(true),
      Effect.timeoutOrElse({ duration: "1 second", orElse: () => Effect.succeed(false) })
    )
    return { status, retryFiberInterrupted }
  }))

describe("ClientSession", () => {
  it.live("fails the layer with BackendUnavailable when first acquisition fails", () =>
    Effect.scoped(Effect.gen(function*() {
      const path = yield* Path.Path
      const dir = yield* makeTempDirectoryScoped("expand-client-session-failure-")
      const failingAdapter: RuntimeAdapter = {
        protocolLayer: nodeAdapter.protocolLayer,
        spawnBackend: () => Effect.fail(new BackendUnavailable({ reason: "expected" }))
      }
      const result = yield* Layer.build(
        ClientSessionLayer(failingAdapter).pipe(
          Layer.provide(ProcessServices.layer),
          Layer.provide(Layer.succeed(AppContext, makeTestAppContext(dir, path)))
        )
      ).pipe(Effect.result)
      expect(Result.isFailure(result)).toBe(true)
    })).pipe(Effect.provide(Layer.mergeAll(ProcessServices.layer, NodeServices.layer))))

  it.live("publishes connected, reconnecting, connected across reacquisition", () =>
    runReconnectScenario((session) => SubscriptionRef.changes(session.status).pipe(
      Stream.takeUntil((status) => status === "connected" && reconnectCount() === 1),
      Stream.runCollect
    )).pipe(
      Effect.tap((observed) => Effect.sync(() =>
        expect(Array.from(observed)).toEqual(["connected", "reconnecting", "connected"])
      )),
      Effect.provide(Layer.mergeAll(ProcessServices.layer, NodeServices.layer))
    ))

  it.live("invalidates the stale epoch before publishing reconnecting", () =>
    runDisconnectOrderingScenario().pipe(
      Effect.tap((result) => Effect.sync(() =>
        expect(result.currentResolvedWhileReconnecting).toBe(false)
      )),
      Effect.provide(Layer.mergeAll(ProcessServices.layer, NodeServices.layer))
    ))

  it.live("does not publish an epoch that disconnects after acquisition", () =>
    runAcquireDisconnectRaceScenario().pipe(
      Effect.tap((result) => Effect.sync(() => expect(result).toBe("retrying"))),
      Effect.provide(Layer.mergeAll(ProcessServices.layer, NodeServices.layer))
    ))

  it.live("closes an owned acquisition scope when acquisition is interrupted", () =>
    runInterruptedAcquireScopeScenario().pipe(
      Effect.tap((closed) => Effect.sync(() => expect(closed).toBe(true))),
      Effect.provide(Layer.mergeAll(ProcessServices.layer, NodeServices.layer))
    ))

  it.live("consumes an acquisition pause only once", () =>
    runOneShotAcquirePauseScenario().pipe(
      Effect.tap((completed) => Effect.sync(() => expect(completed).toBe(true))),
      Effect.provide(Layer.mergeAll(ProcessServices.layer, NodeServices.layer))
    ))

  it.live("closes and clears the server while preserving direct cleanup failures", () =>
    runDirectCleanupFailureScenario.pipe(
      Effect.tap(({ backend, closeDefect, disconnectExit, ownerExit }) => Effect.sync(() => {
        expect(Exit.isFailure(disconnectExit)).toBe(true)
        if (Exit.isFailure(disconnectExit)) {
          expect(Cause.hasFails(disconnectExit.cause)).toBe(true)
          expect(Cause.hasDies(disconnectExit.cause)).toBe(true)
          const defect = Cause.findDefect(disconnectExit.cause)
          expect(Result.isSuccess(defect)).toBe(true)
          if (Result.isSuccess(defect)) expect(defect.success).toBe(closeDefect)
        }
        expect(Exit.isSuccess(ownerExit)).toBe(true)
        expect(backend.hasCurrentServer()).toBe(false)
      })),
      Effect.provide(Layer.mergeAll(ProcessServices.layer, NodeServices.layer))
    ))

  it.live("preserves endpoint cleanup failures as scope-finalizer defects", () =>
    runFinalizerCleanupFailureScenario.pipe(
      Effect.tap(({ backend, closeDefect, endpointRemovalFailure, ownerExit }) => Effect.sync(() => {
        expect(Exit.isFailure(ownerExit)).toBe(true)
        if (Exit.isFailure(ownerExit)) {
          const failReasons = ownerExit.cause.reasons.filter(Cause.isFailReason)
          const dieReasons = ownerExit.cause.reasons.filter(Cause.isDieReason).map((reason) => reason.defect)
          expect(failReasons).toEqual([])
          expect(dieReasons).toContain(endpointRemovalFailure)
          expect(dieReasons).toContain(closeDefect)
        }
        expect(backend.hasCurrentServer()).toBe(false)
      })),
      Effect.provide(Layer.mergeAll(ProcessServices.layer, NodeServices.layer))
    ))

  it.live("publishes a healthy internal acquire retry after a stale transport disconnects", () =>
    runInternalAcquireRetryScenario().pipe(
      Effect.tap((result) => Effect.sync(() => {
        expect(result.attemptedUrls).toHaveLength(2)
        expect(result.attemptedUrls[0]).toContain("127.0.0.1:9")
        expect(result.health).toBe("ok")
        expect(result.status).toBe("connected")
      })),
      Effect.provide(Layer.mergeAll(ProcessServices.layer, NodeServices.layer))
    ), 10_000)

  it.live("current waits for and returns the next epoch", () =>
    runCurrentWaitScenario().pipe(
      Effect.tap((result) => Effect.sync(() => {
        expect(result.second).not.toBe(result.first)
        expect(result.health).toBe("ok")
      })),
      Effect.provide(Layer.mergeAll(ProcessServices.layer, NodeServices.layer))
    ))

  it.live("scope closure publishes disconnected and interrupts retry", () =>
    runScopeClosureScenario().pipe(
      Effect.tap((result) => Effect.sync(() => {
        expect(result.status).toBe("disconnected")
        expect(result.retryFiberInterrupted).toBe(true)
      })),
      Effect.provide(Layer.mergeAll(ProcessServices.layer, NodeServices.layer))
    ))
})

const makeTestAppContext = (dataDir: string, path: Path.Path) =>
  makeAppContext(path, { homeDir: dataDir, cwd: dataDir, dataDir })
