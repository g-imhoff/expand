import { it } from "@effect/vitest"
import { NodePath } from "@effect/platform-node"
import { Cause, ConfigProvider, Deferred, Effect, Exit, Fiber, FiberSet } from "effect"
import { describe, expect } from "vitest"
import {
  DesktopMainError,
  type DesktopIpcHandlers,
  mainProgram,
  type RendererIdentity,
  type CspHost,
  type MainProgramDeps
} from "@expand/desktop/main/application/main-program"
import type { MainPortLike } from "@expand/desktop/main/rpc/server"

const waitFor = Deferred.await
const fiberExit = Fiber.await

interface TestPort extends MainPortLike {
  readonly close: () => void
}

type ReadyResult = Effect.Effect<void, Error>

interface HarnessOptions {
  readonly platform?: string
  readonly packaged?: boolean
  readonly environment?: Record<string, string>
  readonly disposalDefect?: Error
  readonly blockDisposal?: boolean
  readonly blockPortFinalizer?: boolean
  readonly portFinalizerDefect?: Error
  readonly portFinalizerInterrupt?: boolean
  readonly windowDisposalDefect?: Error
}

const makeHarness = Effect.fn("DesktopMainProgramTest.makeHarness")(function* (
  options: HarnessOptions = {}
) {
  const events: Array<string> = []
  const append = (event: string) => { events.push(event) }
  const readyStarted = yield* Deferred.make<void>()
  const readyResult = yield* Deferred.make<ReadyResult>()
  const loadStarted = yield* Deferred.make<void>()
  const loadResult = yield* Deferred.make<ReadyResult>()
  const windowCreated = yield* Deferred.make<void>()
  const windowLoaded = yield* Deferred.make<void>()
  const appListenersReady = yield* Deferred.make<void>()
  const runtimeDisposed = yield* Deferred.make<void>()
  const releaseDisposal = yield* Deferred.make<void>()
  const contextStarted = yield* Deferred.make<void>()
  const portFinalizationStarted = yield* Deferred.make<void>()
  const releasePortFinalization = yield* Deferred.make<void>()
  const portFinalizationDone = yield* Deferred.make<void>()
  const windowFinalizationReached = yield* Deferred.make<void>()
  const callbackFibers = yield* FiberSet.make<void, never>()
  const dispatchCallback = yield* FiberSet.runtime(callbackFibers)<never>()
  let beforeQuit: ((event: { preventDefault: () => void }) => void) | undefined
  let windowAllClosed: (() => void) | undefined
  let closed: (() => void) | undefined
  let navigation: ((details: { readonly isSameDocument: boolean }) => void) | undefined
  let willNavigate: ((event: { preventDefault: () => void }, url: string) => void) | undefined
  let cspListener: Parameters<CspHost["onHeadersReceived"]>[0] | undefined
  let destroyed = false
  let destroyCalls = 0
  let finalQuitCalls = 0
  let quitRequests = 0
  let appListenerCount = 0
  let portFinalizerStarts = 0
  let portFinalizerCompletions = 0
  let portCloseCalls = 0
  const loadedUrls: Array<string> = []
  const loadedFiles: Array<string> = []
  let portGrants = 0
  const frame = { url: "file:///repo/apps/desktop/out/renderer/index.html", detached: false }
  let boundIdentity: RendererIdentity | undefined
  let boundRpcPort: DesktopIpcHandlers<never, TestPort>["rpcPort"] | undefined
  const markAppListener = () => {
    appListenerCount += 1
    if (appListenerCount === 2) Deferred.doneUnsafe(appListenersReady, Effect.void)
  }
  const runtime = {
    contextEffect: options.blockPortFinalizer === true
      ? Effect.scoped(
          Effect.acquireRelease(
            Deferred.succeed(contextStarted, undefined),
            () => Effect.sync(() => { portFinalizerStarts += 1 }).pipe(
              Effect.andThen(Deferred.succeed(portFinalizationStarted, undefined)),
              Effect.andThen(waitFor(releasePortFinalization)),
              Effect.tap(() => Effect.sync(() => { portFinalizerCompletions += 1 })),
              Effect.tap(() => Deferred.succeed(portFinalizationDone, undefined)),
              Effect.andThen(options.portFinalizerInterrupt === true ? Effect.interrupt : Effect.void),
              Effect.andThen(options.portFinalizerDefect === undefined
                ? Effect.void
                : Effect.die(options.portFinalizerDefect))
            )
          ).pipe(Effect.andThen(Effect.never))
        )
      : Deferred.succeed(contextStarted, undefined).pipe(
          Effect.andThen(Effect.never)
        ),
    disposeEffect: Deferred.succeed(runtimeDisposed, undefined).pipe(
      Effect.tap(() => Effect.sync(() => append("runtime:dispose"))),
      Effect.andThen(options.blockDisposal === true ? waitFor(releaseDisposal) : Effect.void),
      Effect.andThen(options.disposalDefect === undefined ? Effect.void : Effect.die(options.disposalDefect))
    )
  }
  const app = {
    isPackaged: options.packaged ?? false,
    ready: Deferred.succeed(readyStarted, undefined).pipe(
      Effect.andThen(waitFor(readyResult)),
      Effect.flatten
    ),
    appendSwitch: (name: string, value: string) => { append(`switch:${name}:${value}`) },
    disableHardwareAcceleration: () => { append("gpu:disable") },
    onBeforeQuit: (listener: (event: { preventDefault: () => void }) => void) => {
      beforeQuit = listener
      markAppListener()
      return () => {
        if (beforeQuit === listener) beforeQuit = undefined
        append("app:off:before-quit")
      }
    },
    onWindowAllClosed: (listener: () => void) => {
      windowAllClosed = listener
      markAppListener()
      return () => {
        if (windowAllClosed === listener) windowAllClosed = undefined
        append("app:off:window-all-closed")
      }
    },
    quit: () => {
      if (beforeQuit === undefined) {
        finalQuitCalls += 1
        append("app:quit:final")
        return
      }
      quitRequests += 1
      let prevented = false
      beforeQuit({ preventDefault: () => { prevented = true } })
      append(`app:quit:request:${String(prevented)}`)
    }
  }
  const window = {
    bindIpc: <R>(identity: RendererIdentity, handlers: DesktopIpcHandlers<R, TestPort>) => {
      boundIdentity = identity
      boundRpcPort = handlers.rpcPort as DesktopIpcHandlers<never, TestPort>["rpcPort"]
      return Effect.acquireRelease(
        Effect.void,
        () => Effect.sync(() => {
          boundRpcPort = undefined
          append("ipc:off")
        })
      )
    },
    onClosed: (listener: () => void) => {
      closed = listener
      return () => {
        if (closed === listener) closed = undefined
        append("window:off:closed")
      }
    },
    onNavigation: (listener: (details: { readonly isSameDocument: boolean }) => void) => {
      navigation = listener
      return () => {
        if (navigation === listener) navigation = undefined
        append("window:off:navigation")
        if (options.windowDisposalDefect !== undefined) throw options.windowDisposalDefect
      }
    },
    onWillNavigate: (listener: (event: { preventDefault: () => void }, url: string) => void) => {
      willNavigate = listener
      return () => {
        if (willNavigate === listener) willNavigate = undefined
        append("window:off:will-navigate")
      }
    },
    setWindowOpenHandler: (_handler: (details: { url: string }) => { action: "deny" }) => {},
    loadUrl: (url: string) => Effect.sync(() => { loadedUrls.push(url) }).pipe(
      Effect.andThen(Deferred.succeed(loadStarted, undefined)),
      Effect.andThen(waitFor(loadResult)),
      Effect.flatten,
      Effect.tap(() => Deferred.succeed(windowLoaded, undefined))
    ),
    loadFile: (path: string) => Effect.sync(() => { loadedFiles.push(path) }).pipe(
      Effect.andThen(Deferred.succeed(loadStarted, undefined)),
      Effect.andThen(waitFor(loadResult)),
      Effect.flatten,
      Effect.tap(() => Deferred.succeed(windowLoaded, undefined))
    ),
    isDestroyed: () => {
      Deferred.doneUnsafe(windowFinalizationReached, Effect.void)
      return destroyed
    },
    destroy: () => {
      destroyed = true
      destroyCalls += 1
      append("window:destroy")
    }
  }
  const deps: MainProgramDeps<TestPort> = {
    app,
    platform: options.platform ?? "linux",
    moduleUrl: new URL("file:///repo/apps/desktop/out/main/index.mjs"),
    createWindow: (_options) => {
      Deferred.doneUnsafe(windowCreated, Effect.void)
      append("window:create")
      return window
    },
    makeMessageChannel: () => {
      const endpoint = (): TestPort => ({
        postMessage: (_message: unknown) => {},
        on: (
          _event: "message" | "close",
          _listener: ((event: { data: unknown }) => void) | (() => void)
        ) => {},
        off: (
          _event: "message" | "close",
          _listener: ((event: { data: unknown }) => void) | (() => void)
        ) => {},
        start: () => {},
        close: () => { portCloseCalls += 1 }
      })
      return { port1: endpoint(), port2: endpoint() }
    },
    csp: {
      onHeadersReceived: (listener) => {
        cspListener = listener
        append("csp:on")
        return () => {
          if (cspListener === listener) cspListener = undefined
          append("csp:off")
        }
      }
    },
    makeRuntime: () => runtime
  }
  const program = mainProgram(deps).pipe(
    Effect.provide(NodePath.layer),
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown(options.environment ?? {})
    )
  )
  const fireBeforeQuit = () => {
    let prevented = false
    beforeQuit?.({ preventDefault: () => { prevented = true } })
    return prevented
  }
  return {
    program,
    events,
    readyStarted,
    windowCreated,
    loadStarted,
    windowLoaded,
    appListenersReady,
    runtimeDisposed,
    contextStarted,
    portFinalizationStarted,
    portFinalizationDone,
    windowFinalizationReached,
    succeedReady: Deferred.succeed(readyResult, Effect.void),
    failReady: (error: Error) => Deferred.succeed(readyResult, Effect.fail(error)),
    succeedLoad: Deferred.succeed(loadResult, Effect.void),
    failLoad: (error: Error) => Deferred.succeed(loadResult, Effect.fail(error)),
    releaseDisposal: Deferred.succeed(releaseDisposal, undefined),
    releasePortFinalization: Deferred.succeed(releasePortFinalization, undefined),
    fireBeforeQuit,
    fireWindowAllClosed: () => { windowAllClosed?.() },
    fireClosed: () => {
      destroyed = true
      closed?.()
    },
    fireNavigation: () => { navigation?.({ isSameDocument: false }) },
    fireWillNavigate: (url: string) => {
      let prevented = false
      willNavigate?.({ preventDefault: () => { prevented = true } }, url)
      return prevented
    },
    fireRpcPortRequest: (url = frame.url) => {
      frame.url = url
      if (boundRpcPort === undefined) return
      const trusted = boundIdentity?._tag === "url"
        ? new URL(url).href === boundIdentity.value
        : boundIdentity?._tag === "origin" && new URL(url).origin === boundIdentity.value
      if (!trusted) return
      dispatchCallback(boundRpcPort(
        { frameUrl: url },
        () => Effect.sync(() => { portGrants += 1 })
      ))
    },
    destroyCalls: () => destroyCalls,
    finalQuitCalls: () => finalQuitCalls,
    quitRequests: () => quitRequests,
    portFinalizerStarts: () => portFinalizerStarts,
    portFinalizerCompletions: () => portFinalizerCompletions,
    portCloseCalls: () => portCloseCalls,
    loadedUrls,
    loadedFiles,
    portGrants: () => portGrants,
    boundIdentity: () => boundIdentity,
    isCspInstalled: () => cspListener !== undefined,
    hasIpcListener: () => boundRpcPort !== undefined,
    hasNavigationListener: () => navigation !== undefined || willNavigate !== undefined
  }
})

const start = (harness: Effect.Success<ReturnType<typeof makeHarness>>) =>
  harness.program.pipe(Effect.forkChild({ startImmediately: true }))

describe("mainProgram startup and shutdown", () => {
  it.effect("uses the exact packaged renderer identity for loading, navigation, and IPC", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          packaged: true,
          environment: { ELECTRON_RENDERER_URL: "https://attacker.example/app" }
        })
        const fiber = yield* start(harness)
        yield* waitFor(harness.readyStarted)
        yield* harness.succeedReady
        yield* waitFor(harness.loadStarted)
        expect(harness.loadedUrls).toEqual([])
        expect(harness.loadedFiles).toEqual(["/repo/apps/desktop/out/renderer/index.html"])
        expect(harness.boundIdentity()).toEqual({
          _tag: "url",
          value: "file:///repo/apps/desktop/out/renderer/index.html"
        })
        expect(harness.fireWillNavigate("file:///repo/apps/desktop/out/renderer/index.html")).toBe(false)
        harness.fireRpcPortRequest("file:///repo/apps/desktop/out/renderer/index.html")
        yield* Effect.yieldNow
        expect(harness.portGrants()).toBe(1)
        yield* harness.succeedLoad
        yield* waitFor(harness.windowLoaded)
        expect(harness.fireBeforeQuit()).toBe(true)
        expect(Exit.isSuccess(yield* fiberExit(fiber))).toBe(true)
      })
    ))

  it.effect("rejects sibling packaged file navigation and IPC", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ packaged: true })
        const fiber = yield* start(harness)
        yield* waitFor(harness.readyStarted)
        yield* harness.succeedReady
        yield* waitFor(harness.loadStarted)
        const hostileFile = "file:///repo/apps/desktop/out/renderer/hostile.html"
        expect(harness.fireWillNavigate(hostileFile)).toBe(true)
        harness.fireRpcPortRequest(hostileFile)
        yield* Effect.yieldNow
        expect(harness.portGrants()).toBe(0)
        yield* harness.succeedLoad
        yield* waitFor(harness.windowLoaded)
        expect(harness.fireBeforeQuit()).toBe(true)
        expect(Exit.isSuccess(yield* fiberExit(fiber))).toBe(true)
      })
    ))

  it.effect("rejects an invalid development renderer URL with DesktopMainError", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ environment: { ELECTRON_RENDERER_URL: "not a url" } })
      const error = yield* Effect.flip(harness.program)
      expect(error).toBeInstanceOf(DesktopMainError)
      expect(error).toMatchObject({ reason: "invalid-renderer-url", value: "not a url" })
      expect(harness.loadedUrls).toEqual([])
      expect(harness.loadedFiles).toEqual([])
    }))

  it.effect("configures host switches before readiness and keeps backend acquisition lazy through renderer load", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          environment: {
            EXPAND_DEVTOOLS_CDP: "1",
            SSH_CONNECTION: "connected",
            ELECTRON_RENDERER_URL: "http://localhost:5173"
          }
        })
        const fiber = yield* start(harness)
        yield* waitFor(harness.readyStarted)
        expect(harness.events).toEqual([
          "switch:remote-debugging-port:9222",
          "gpu:disable"
        ])
        yield* harness.succeedReady
        yield* waitFor(harness.loadStarted)
        expect(harness.boundIdentity()).toEqual({ _tag: "origin", value: "http://localhost:5173" })
        expect(yield* Deferred.isDone(harness.contextStarted)).toBe(false)
        yield* harness.succeedLoad
        yield* waitFor(harness.windowLoaded)
        expect(harness.isCspInstalled()).toBe(false)
        expect(harness.fireBeforeQuit()).toBe(true)
        expect(Exit.isSuccess(yield* fiberExit(fiber))).toBe(true)
        expect(harness.finalQuitCalls()).toBe(1)
      })
    ))

  it.effect("releases a partial startup and final-quits once when readiness fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness()
        const fiber = yield* start(harness)
        yield* waitFor(harness.readyStarted)
        yield* harness.failReady(new Error("readiness failed"))
        expect(Exit.isFailure(yield* fiberExit(fiber))).toBe(true)
        expect(yield* Deferred.isDone(harness.windowCreated)).toBe(false)
        expect(harness.finalQuitCalls()).toBe(1)
      })
    ))

  it.effect("interrupts pending readiness on early before-quit and ignores its late settlement", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness()
        const fiber = yield* start(harness)
        yield* waitFor(harness.readyStarted)
        expect(harness.fireBeforeQuit()).toBe(true)
        expect(Exit.isSuccess(yield* fiberExit(fiber))).toBe(true)
        yield* harness.succeedReady
        expect(yield* Deferred.isDone(harness.windowCreated)).toBe(false)
        expect(harness.finalQuitCalls()).toBe(1)
      })
    ))

  it.effect("releases loaded resources when renderer loading fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ packaged: true })
        const fiber = yield* start(harness)
        yield* waitFor(harness.readyStarted)
        yield* harness.succeedReady
        yield* waitFor(harness.loadStarted)
        expect(harness.isCspInstalled()).toBe(true)
        yield* harness.failLoad(new Error("load failed"))
        expect(Exit.isFailure(yield* fiberExit(fiber))).toBe(true)
        expect(harness.isCspInstalled()).toBe(false)
        expect(harness.hasIpcListener()).toBe(false)
        expect(harness.hasNavigationListener()).toBe(false)
        expect(harness.destroyCalls()).toBe(1)
        expect(harness.finalQuitCalls()).toBe(1)
      })
    ))

  it.effect("interrupts pending renderer loading on early before-quit and ignores late settlement", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ packaged: true })
        const fiber = yield* start(harness)
        yield* waitFor(harness.readyStarted)
        yield* harness.succeedReady
        yield* waitFor(harness.loadStarted)
        expect(harness.fireBeforeQuit()).toBe(true)
        expect(Exit.isSuccess(yield* fiberExit(fiber))).toBe(true)
        yield* harness.succeedLoad
        expect(yield* Deferred.isDone(harness.windowLoaded)).toBe(false)
        expect(harness.isCspInstalled()).toBe(false)
        expect(harness.hasIpcListener()).toBe(false)
        expect(harness.hasNavigationListener()).toBe(false)
        expect(harness.destroyCalls()).toBe(1)
        expect(harness.finalQuitCalls()).toBe(1)
      })
    ))

  it.effect("prevents repeated quit while cleanup is blocked and final-quits only after release", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ blockDisposal: true })
        const fiber = yield* start(harness)
        yield* waitFor(harness.readyStarted)
        yield* harness.succeedReady
        yield* waitFor(harness.loadStarted)
        yield* harness.succeedLoad
        yield* waitFor(harness.windowLoaded)
        expect(harness.fireBeforeQuit()).toBe(true)
        expect(harness.fireBeforeQuit()).toBe(true)
        yield* waitFor(harness.runtimeDisposed)
        expect(harness.finalQuitCalls()).toBe(0)
        yield* harness.releaseDisposal
        expect(Exit.isSuccess(yield* fiberExit(fiber))).toBe(true)
        expect(harness.finalQuitCalls()).toBe(1)
      })
    ))

  it.effect("observes runtime disposal defects after one final quit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ disposalDefect: new Error("dispose failed") })
        const fiber = yield* start(harness)
        yield* waitFor(harness.readyStarted)
        yield* harness.succeedReady
        yield* waitFor(harness.loadStarted)
        yield* harness.succeedLoad
        yield* waitFor(harness.windowLoaded)
        expect(harness.fireBeforeQuit()).toBe(true)
        expect(Exit.isFailure(yield* fiberExit(fiber))).toBe(true)
        expect(harness.finalQuitCalls()).toBe(1)
      })
    ))
})

describe("mainProgram window ownership", () => {
  it.effect("keeps Darwin resident after window close without disposing the application runtime", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ platform: "darwin" })
        const fiber = yield* start(harness)
        yield* waitFor(harness.readyStarted)
        yield* harness.succeedReady
        yield* waitFor(harness.loadStarted)
        yield* harness.succeedLoad
        yield* waitFor(harness.windowLoaded)
        harness.fireClosed()
        yield* Effect.yieldNow
        expect(yield* Deferred.isDone(harness.runtimeDisposed)).toBe(false)
        expect(harness.destroyCalls()).toBe(0)
        harness.fireWindowAllClosed()
        expect(harness.quitRequests()).toBe(0)
        expect(harness.fireBeforeQuit()).toBe(true)
        expect(Exit.isSuccess(yield* fiberExit(fiber))).toBe(true)
      })
    ))

  it.effect("initiates quit on non-Darwin window-all-closed and preserves cleanup order", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ packaged: true })
        const fiber = yield* start(harness)
        yield* waitFor(harness.readyStarted)
        yield* harness.succeedReady
        yield* waitFor(harness.loadStarted)
        yield* harness.succeedLoad
        yield* waitFor(harness.windowLoaded)
        harness.fireWindowAllClosed()
        expect(Exit.isSuccess(yield* fiberExit(fiber))).toBe(true)
        expect(harness.quitRequests()).toBe(1)
        expect(harness.finalQuitCalls()).toBe(1)
        const events = harness.events
        const ipcOff = events.indexOf("ipc:off")
        const navigationOff = events.indexOf("window:off:navigation")
        const cspOff = events.indexOf("csp:off")
        const destroy = events.indexOf("window:destroy")
        const runtimeDispose = events.indexOf("runtime:dispose")
        const appOff = events.indexOf("app:off:before-quit")
        const finalQuit = events.indexOf("app:quit:final")
        expect(ipcOff).toBeGreaterThanOrEqual(0)
        expect(ipcOff).toBeLessThan(navigationOff)
        expect(navigationOff).toBeLessThan(cspOff)
        expect(cspOff).toBeLessThan(destroy)
        expect(destroy).toBeLessThan(runtimeDispose)
        expect(runtimeDispose).toBeLessThan(appOff)
        expect(appOff).toBeLessThan(finalQuit)
      })
    ))

  it.effect("unbinds IPC before an open broker port and later window resources finalize", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          platform: "darwin",
          packaged: true,
          blockPortFinalizer: true
        })
        const fiber = yield* start(harness)
        yield* waitFor(harness.readyStarted)
        yield* harness.succeedReady
        yield* waitFor(harness.loadStarted)
        yield* harness.succeedLoad
        yield* waitFor(harness.windowLoaded)
        harness.fireRpcPortRequest()
        yield* waitFor(harness.contextStarted)
        harness.fireClosed()
        yield* waitFor(harness.portFinalizationStarted)
        yield* Effect.gen(function* () {
          expect(harness.hasIpcListener()).toBe(false)
          expect(harness.hasNavigationListener()).toBe(true)
          expect(harness.isCspInstalled()).toBe(true)
          expect(yield* Deferred.isDone(harness.windowFinalizationReached)).toBe(false)
        }).pipe(Effect.ensuring(harness.releasePortFinalization))
        yield* waitFor(harness.portFinalizationDone)
        yield* waitFor(harness.windowFinalizationReached)
        expect(harness.hasNavigationListener()).toBe(false)
        expect(harness.isCspInstalled()).toBe(false)
        expect(harness.portFinalizerStarts()).toBe(1)
        expect(harness.portFinalizerCompletions()).toBe(1)
        expect(harness.portCloseCalls()).toBe(1)
        expect(harness.fireBeforeQuit()).toBe(true)
        expect(Exit.isSuccess(yield* fiberExit(fiber))).toBe(true)
      })
    ))

  it.effect("joins callback-driven window cleanup before runtime disposal and final quit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ packaged: true, blockPortFinalizer: true })
        const fiber = yield* start(harness)
        yield* waitFor(harness.readyStarted)
        yield* harness.succeedReady
        yield* waitFor(harness.loadStarted)
        yield* harness.succeedLoad
        yield* waitFor(harness.windowLoaded)
        harness.fireRpcPortRequest()
        yield* waitFor(harness.contextStarted)
        harness.fireClosed()
        yield* waitFor(harness.portFinalizationStarted)
        expect(harness.fireBeforeQuit()).toBe(true)
        yield* Effect.gen(function* () {
          yield* Effect.yieldNow
          expect(yield* Deferred.isDone(harness.runtimeDisposed)).toBe(false)
          expect(harness.finalQuitCalls()).toBe(0)
          expect(harness.portFinalizerStarts()).toBe(1)
          expect(harness.portFinalizerCompletions()).toBe(0)
        }).pipe(Effect.ensuring(harness.releasePortFinalization))
        expect(Exit.isSuccess(yield* fiberExit(fiber))).toBe(true)
        expect(yield* Deferred.isDone(harness.runtimeDisposed)).toBe(true)
        expect(harness.finalQuitCalls()).toBe(1)
        expect(harness.portFinalizerStarts()).toBe(1)
        expect(harness.portFinalizerCompletions()).toBe(1)
        expect(harness.portCloseCalls()).toBe(1)
      })
    ))

  it.effect("fails the application when a callback-owned cleanup defects", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const callbackDefect = new Error("callback cleanup failed")
        const harness = yield* makeHarness({
          packaged: true,
          windowDisposalDefect: callbackDefect
        })
        const fiber = yield* start(harness)
        yield* waitFor(harness.readyStarted)
        yield* harness.succeedReady
        yield* waitFor(harness.loadStarted)
        yield* harness.succeedLoad
        yield* waitFor(harness.windowLoaded)
        harness.fireClosed()
        const exit = yield* fiberExit(fiber)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(callbackDefect)
        expect(harness.finalQuitCalls()).toBe(1)
      })
    ))

  it.effect("keeps callback interruption from failing the application lifecycle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          packaged: true,
          blockPortFinalizer: true,
          portFinalizerInterrupt: true
        })
        const fiber = yield* start(harness)
        yield* waitFor(harness.readyStarted)
        yield* harness.succeedReady
        yield* waitFor(harness.loadStarted)
        yield* harness.succeedLoad
        yield* waitFor(harness.windowLoaded)
        harness.fireRpcPortRequest()
        yield* waitFor(harness.contextStarted)
        harness.fireNavigation()
        yield* waitFor(harness.portFinalizationStarted)
        yield* harness.releasePortFinalization
        yield* waitFor(harness.portFinalizationDone)
        expect(fiber.pollUnsafe()).toBeUndefined()
        expect(harness.fireBeforeQuit()).toBe(true)
        expect(Exit.isSuccess(yield* fiberExit(fiber))).toBe(true)
      })
    ))

  it.effect("preserves a shared window cleanup defect through application shutdown", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          packaged: true,
          blockPortFinalizer: true,
          windowDisposalDefect: new Error("window cleanup failed")
        })
        const fiber = yield* start(harness)
        yield* waitFor(harness.readyStarted)
        yield* harness.succeedReady
        yield* waitFor(harness.loadStarted)
        yield* harness.succeedLoad
        yield* waitFor(harness.windowLoaded)
        harness.fireRpcPortRequest()
        yield* waitFor(harness.contextStarted)
        harness.fireClosed()
        yield* waitFor(harness.portFinalizationStarted)
        expect(harness.fireBeforeQuit()).toBe(true)
        yield* harness.releasePortFinalization
        const exit = yield* fiberExit(fiber)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(String(Cause.squash(exit.cause))).toContain("window cleanup failed")
        }
        expect(harness.portFinalizerStarts()).toBe(1)
        expect(harness.portFinalizerCompletions()).toBe(1)
        expect(harness.portCloseCalls()).toBe(1)
        expect(harness.finalQuitCalls()).toBe(1)
      })
    ))
})
