import { it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Stream } from "effect"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, vi } from "vitest"
import { BootError } from "@expand/desktop/renderer/app/BootError"
import { ownRendererRoot } from "@expand/desktop/renderer/app/root"
import { acquireRpcPort } from "@expand/desktop/renderer/app/runtime"
import {
  RendererRunnerProvider,
  useRendererRunner
} from "@expand/desktop/renderer/app/runner-context"
import { startRendererRoot, type RendererRunner } from "@expand/desktop/renderer/app/runner"
import {
  ProjectContextProvider,
  useProjectRpc
} from "@expand/desktop/renderer/features/projects/data/project-context"
import { makeProjectsStore } from "@expand/desktop/renderer/features/projects/data/project-store"
import type { ProjectRpcApi } from "@expand/desktop/renderer/rpc/project-rpc"

const waitForDeferred = Deferred.await

const runner: RendererRunner = {
  start: () => () => {}
}

const rpc: ProjectRpcApi = {
  create: () => Effect.never,
  rename: () => Effect.never,
  changeDirectory: () => Effect.never,
  archive: () => Effect.never,
  restore: () => Effect.never,
  setMetadata: () => Effect.never,
  delete: () => Effect.never,
  list: () => Effect.never,
  status: Stream.never,
  events: () => Stream.never
}

const captureThrow = (operation: () => unknown): unknown => {
  try {
    operation()
  } catch (error) {
    return error
  }
  throw new Error("operation did not throw")
}

class LifecycleMessagePort implements MessagePort {
  onmessage: ((this: MessagePort, ev: MessageEvent) => unknown) | null = null
  onmessageerror: ((this: MessagePort, ev: MessageEvent) => unknown) | null = null
  closes = 0
  closed = false

  close(): void {
    if (this.closed) return
    this.closed = true
    this.closes += 1
  }

  emit(data: unknown): void {
    if (!this.closed) this.onmessage?.call(this, { data } as MessageEvent)
  }

  postMessage(_message: unknown, _transferOrOptions?: Transferable[] | StructuredSerializeOptions): void {}
  start(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(): boolean { return true }
}

interface RootHarnessOptions {
  readonly events?: Array<string>
  readonly renderError?: Error
  readonly registrationError?: Error
  readonly startError?: Error
  readonly releaseError?: Error
  readonly unmountError?: Error
  readonly interruptError?: Error
  readonly failDuringRelease?: boolean
}

class ReceiverSensitiveRoot {
  mounted = false

  constructor(readonly events: Array<string>) {}

  render(_node: React.ReactNode): void {
    this.mounted = true
    this.events.push("render")
  }

  unmount(): void {
    this.mounted = false
    this.events.push("unmount")
  }
}

const makeRootHarness = (options: RootHarnessOptions = {}) => {
  const events = options.events ?? []
  const renders: Array<React.ReactNode> = []
  let activeDispose: (() => void) | undefined
  let retainedDispose: (() => void) | undefined
  let hmrDispose: (() => void) | undefined
  let rootExit: ((exit: Exit.Exit<never, string>) => void) | undefined
  const retry = vi.fn()
  const root = {
    render: (node: React.ReactNode) => {
      events.push("render")
      renders.push(node)
      if (options.renderError !== undefined) throw options.renderError
    },
    unmount: () => {
      events.push("unmount")
      if (options.unmountError !== undefined) throw options.unmountError
    }
  }
  const onDispose = (dispose: () => void) => {
    events.push("register")
    activeDispose = dispose
    retainedDispose = dispose
    hmrDispose = dispose
    if (options.registrationError !== undefined) {
      events.push("release")
      activeDispose = undefined
      throw options.registrationError
    }
    return () => {
      events.push("release")
      activeDispose = undefined
      if (options.failDuringRelease === true) rootExit?.(Exit.fail("late failure"))
      if (options.releaseError !== undefined) throw options.releaseError
    }
  }
  const start = (onExit: (exit: Exit.Exit<never, string>) => void) => {
    events.push("start")
    rootExit = onExit
    if (options.startError !== undefined) throw options.startError
    return () => {
      events.push("interrupt")
      if (options.interruptError !== undefined) throw options.interruptError
    }
  }
  const dispose = ownRendererRoot({
    root,
    initial: <p>Connecting…</p>,
    start,
    onDispose,
    renderFailure: (cause) => <BootError message={Cause.pretty(cause)} onRetry={retry} />
  })
  return {
    dispose,
    events,
    renders,
    retry,
    rootExit: (exit: Exit.Exit<never, string>) => rootExit?.(exit),
    fireUnload: () => activeDispose?.(),
    fireRetainedUnload: () => retainedDispose?.(),
    fireHmr: () => hmrDispose?.(),
    registeredIdentity: () => ({ activeDispose, retainedDispose, hmrDispose })
  }
}

describe("renderer runner context", () => {
  it.effect("keeps the runner and project providers independent", () =>
    Effect.sync(() => {
      const store = makeProjectsStore()
      let observedRunner: RendererRunner | undefined
      let observedRpc: ProjectRpcApi | undefined
      const ReadContexts = () => {
        observedRunner = useRendererRunner()
        observedRpc = useProjectRpc()
        return null
      }
      renderToStaticMarkup(
        <RendererRunnerProvider value={runner}>
          <ProjectContextProvider value={{ store, rpc }}>
            <ReadContexts />
          </ProjectContextProvider>
        </RendererRunnerProvider>
      )
      expect(observedRunner).toBe(runner)
      expect(observedRpc).toBe(rpc)
      expect(Object.keys({ store, rpc })).toEqual(["store", "rpc"])
    }))

  it.effect("fails precisely when the runner provider is missing", () =>
    Effect.sync(() => {
      const ReadRunner = () => {
        useRendererRunner()
        return null
      }
      expect(() => renderToStaticMarkup(<ReadRunner />)).toThrow(
        "renderer runner must be used within <RendererRunnerProvider>"
      )
    }))
})

describe("renderer root ownership", () => {
  it.effect("releases the active renderer runtime, listeners, root, and MessagePort after failure", () =>
    Effect.gen(function* () {
      const listenerRegistered = yield* Deferred.make<void>()
      const portRequested = yield* Deferred.make<void>()
      const portAcquired = yield* Deferred.make<void>()
      const runtimeInterrupted = yield* Deferred.make<void>()
      const messageListeners = new Set<(event: {
        readonly data: unknown
        readonly source: unknown
        readonly ports: ReadonlyArray<MessagePort>
      }) => void>()
      const retainedMessageListeners: Array<(event: {
        readonly data: unknown
        readonly source: unknown
        readonly ports: ReadonlyArray<MessagePort>
      }) => void> = []
      let messageAdds = 0
      let messageRemoves = 0
      const win = {
        addEventListener: (_type: "message", listener: (event: never) => void) => {
          messageAdds += 1
          messageListeners.add(listener as (event: {
            readonly data: unknown
            readonly source: unknown
            readonly ports: ReadonlyArray<MessagePort>
          }) => void)
          retainedMessageListeners.push(listener as (event: {
            readonly data: unknown
            readonly source: unknown
            readonly ports: ReadonlyArray<MessagePort>
          }) => void)
          Deferred.doneUnsafe(listenerRegistered, Effect.void)
        },
        removeEventListener: (_type: "message", listener: (event: never) => void) => {
          messageRemoves += 1
          messageListeners.delete(listener as (event: {
            readonly data: unknown
            readonly source: unknown
            readonly ports: ReadonlyArray<MessagePort>
          }) => void)
        }
      }
      let requestedNonce = ""
      const bridge = {
        rpcPort: (nonce: string) => {
          requestedNonce = nonce
          Deferred.doneUnsafe(portRequested, Effect.void)
        }
      }
      const port = new LifecycleMessagePort()
      let portMessages = 0
      let rootRenders = 0
      let rootUnmounts = 0
      let unloadAdds = 0
      let unloadRemoves = 0
      let activeUnload: (() => void) | undefined
      let retainedUnload: (() => void) | undefined
      const root = {
        render: () => { rootRenders += 1 },
        unmount: () => { rootUnmounts += 1 }
      }
      const rootEffect = Effect.scoped(Effect.acquireRelease(
        acquireRpcPort({ bridge: () => bridge, win, nonce: Effect.succeed("nonce") }),
        (owned) => Effect.sync(() => owned.close())
      ).pipe(
        Effect.tap((owned) => Effect.sync(() => {
          owned.onmessage = () => { portMessages += 1 }
          Deferred.doneUnsafe(portAcquired, Effect.void)
        })),
        Effect.andThen(Effect.never)
      )).pipe(
        Effect.onInterrupt(() => Deferred.succeed(runtimeInterrupted, undefined))
      )
      const exit = yield* Effect.exit(Effect.scoped(Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() => ownRendererRoot({
            root,
            initial: <p>Connecting…</p>,
            start: (onExit) => startRendererRoot(rootEffect, onExit),
            onDispose: (dispose) => {
              unloadAdds += 1
              activeUnload = dispose
              retainedUnload = dispose
              return () => {
                unloadRemoves += 1
                activeUnload = undefined
              }
            },
            renderFailure: () => null
          })),
          (dispose) => Effect.sync(dispose)
        )
        yield* Effect.all([waitForDeferred(listenerRegistered), waitForDeferred(portRequested)])
        for (const listener of messageListeners) {
          listener({
            data: { _tag: "IpcPortGrant", channel: "expand:rpcPort", nonce: requestedNonce },
            source: win,
            ports: [port]
          })
        }
        yield* waitForDeferred(portAcquired)
        port.emit("active")
        expect(portMessages).toBe(1)
        return yield* Effect.fail("expected renderer assertion failure")
      })))

      expect(Exit.isFailure(exit)).toBe(true)
      yield* waitForDeferred(runtimeInterrupted)
      expect(rootRenders).toBe(1)
      expect(rootUnmounts).toBe(1)
      expect(messageAdds).toBe(1)
      expect(messageRemoves).toBe(1)
      expect(unloadAdds).toBe(1)
      expect(unloadRemoves).toBe(1)
      expect(port.closes).toBe(1)
      expect(activeUnload).toBeUndefined()
      port.emit("retained")
      retainedUnload?.()
      for (const listener of retainedMessageListeners) {
        listener({
          data: { _tag: "IpcPortGrant", channel: "expand:rpcPort", nonce: "retained" },
          source: win,
          ports: [new LifecycleMessagePort()]
        })
      }
      yield* Effect.yieldNow
      expect(portMessages).toBe(1)
      expect(rootUnmounts).toBe(1)
      expect(port.closes).toBe(1)
    }))

  it.effect("invokes receiver-sensitive unmount before root interruption", () =>
    Effect.sync(() => {
      const events: Array<string> = []
      const root = new ReceiverSensitiveRoot(events)
      const dispose = ownRendererRoot({
        root,
        initial: <p>Connecting…</p>,
        start: () => () => events.push("interrupt"),
        onDispose: () => () => events.push("release"),
        renderFailure: () => null
      })
      expect(root.mounted).toBe(true)
      expect(dispose).not.toThrow()
      expect(root.mounted).toBe(false)
      expect(events).toEqual(["render", "release", "unmount", "interrupt"])
    }))

  it.effect("invokes receiver-sensitive unmount during startup rollback", () =>
    Effect.sync(() => {
      const events: Array<string> = []
      const root = new ReceiverSensitiveRoot(events)
      const startError = new Error("start failed")
      const thrown = captureThrow(() => ownRendererRoot({
        root,
        initial: <p>Connecting…</p>,
        start: () => {
          events.push("start")
          throw startError
        },
        onDispose: () => {
          events.push("register")
          return () => events.push("release")
        },
        renderFailure: () => null
      }))
      expect(thrown).toBe(startError)
      expect(root.mounted).toBe(false)
      expect(events).toEqual(["render", "register", "start", "release", "unmount"])
    }))

  it.effect("renders one active non-interruption failure and ignores interruption", () =>
    Effect.sync(() => {
      const harness = makeRootHarness()
      harness.rootExit(Exit.interrupt())
      expect(harness.renders).toHaveLength(1)
      harness.rootExit(Exit.fail("boot failed"))
      expect(harness.renders).toHaveLength(2)
      expect(renderToStaticMarkup(harness.renders[1])).toContain("boot failed")
      harness.dispose()
    }))

  it.effect("shares one exact idempotent disposer across unload and HMR", () =>
    Effect.sync(() => {
      const harness = makeRootHarness()
      const identities = harness.registeredIdentity()
      expect(identities.activeDispose).toBe(identities.retainedDispose)
      expect(identities.activeDispose).toBe(identities.hmrDispose)
      harness.fireUnload()
      harness.fireHmr()
      harness.fireRetainedUnload()
      harness.dispose()
      expect(harness.events.filter((event) => event === "release")).toHaveLength(1)
      expect(harness.events.filter((event) => event === "unmount")).toHaveLength(1)
      expect(harness.events.filter((event) => event === "interrupt")).toHaveLength(1)
    }))

  it.effect("deactivates before listener release, unmount, and root interruption", () =>
    Effect.sync(() => {
      const harness = makeRootHarness({ failDuringRelease: true })
      harness.dispose()
      expect(harness.events.slice(-3)).toEqual(["release", "unmount", "interrupt"])
      expect(harness.renders).toHaveLength(1)
      harness.rootExit(Exit.fail("later failure"))
      expect(harness.renders).toHaveLength(1)
    }))

  it.effect("attempts interruption after cleanup defects and preserves cause order", () =>
    Effect.sync(() => {
      const releaseError = new Error("release failed")
      const unmountError = new Error("unmount failed")
      const interruptError = new Error("interrupt failed")
      const single = makeRootHarness({ releaseError })
      expect(captureThrow(single.dispose)).toBe(releaseError)
      expect(single.events.slice(-3)).toEqual(["release", "unmount", "interrupt"])
      const multiple = makeRootHarness({ releaseError, unmountError, interruptError })
      const thrown = captureThrow(multiple.dispose)
      expect(thrown).toBeInstanceOf(AggregateError)
      if (!(thrown instanceof AggregateError)) throw thrown
      expect(thrown.errors).toEqual([releaseError, unmountError, interruptError])
      expect(multiple.events.slice(-3)).toEqual(["release", "unmount", "interrupt"])
    }))

  it.effect("rolls back initial render, registration, and startup failures", () =>
    Effect.sync(() => {
      const renderError = new Error("render failed")
      const renderEvents: Array<string> = []
      expect(captureThrow(() => makeRootHarness({ events: renderEvents, renderError }))).toBe(renderError)
      expect(renderEvents).toEqual(["render", "unmount"])
      const registrationError = new Error("registration failed")
      const registrationEvents: Array<string> = []
      expect(captureThrow(() => makeRootHarness({
        events: registrationEvents,
        registrationError
      }))).toBe(registrationError)
      expect(registrationEvents).toEqual(["render", "register", "release", "unmount"])
      const startError = new Error("start failed")
      const startEvents: Array<string> = []
      expect(captureThrow(() => makeRootHarness({ events: startEvents, startError }))).toBe(startError)
      expect(startEvents).toEqual(["render", "register", "start", "release", "unmount"])
      const releaseError = new Error("rollback release failed")
      const unmountError = new Error("rollback unmount failed")
      const aggregateEvents: Array<string> = []
      const thrown = captureThrow(() => makeRootHarness({
        events: aggregateEvents,
        startError,
        releaseError,
        unmountError
      }))
      expect(thrown).toBeInstanceOf(AggregateError)
      if (!(thrown instanceof AggregateError)) throw thrown
      expect(thrown.errors).toEqual([startError, releaseError, unmountError])
      expect(aggregateEvents).toEqual(["render", "register", "start", "release", "unmount"])
    }))
})
