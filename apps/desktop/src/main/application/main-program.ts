import {
  Cause,
  Config,
  Data,
  Deferred,
  Effect,
  Exit,
  FiberSet,
  Option,
  Path,
  Scope
} from "effect"
import type { IpcHandlersOf } from "@expand/electron-ipc/contract"
import type { MainPortLike } from "@expand/desktop/main/rpc/server"
import { connectPort, type RpcRuntime } from "@expand/desktop/main/rpc/transport"
import {
  wirePortLifecycle,
  type PortEndpoint
} from "@expand/desktop/main/ipc/port-lifecycle"
import { hardenWebContents } from "@expand/desktop/main/security/harden-web-contents"
import { windowOptions } from "@expand/desktop/main/security/window-options"
import { ExpandIpc } from "@expand/desktop/shared/ipc/channels"

export class DesktopMainError extends Data.TaggedError("DesktopMainError")<{
  readonly reason: "invalid-renderer-url" | "host"
  readonly value?: string
  readonly cause?: unknown
}> {}

export interface DesktopRuntime extends RpcRuntime {
  readonly disposeEffect: Effect.Effect<void>
}

export interface DesktopAppHost {
  readonly isPackaged: boolean
  readonly ready: Effect.Effect<void, unknown>
  readonly appendSwitch: (name: string, value: string) => void
  readonly disableHardwareAcceleration: () => void
  readonly onBeforeQuit: (listener: (event: { preventDefault: () => void }) => void) => () => void
  readonly onWindowAllClosed: (listener: () => void) => () => void
  readonly quit: () => void
}

export interface DesktopWindowHost<Port> {
  readonly bindIpc: <R>(
    identity: RendererIdentity,
    handlers: DesktopIpcHandlers<R, Port>
  ) => Effect.Effect<unknown, unknown, R | Scope.Scope>
  readonly onClosed: (listener: () => void) => () => void
  readonly onNavigation: (
    listener: (details: { readonly isSameDocument: boolean }) => void
  ) => () => void
  readonly onWillNavigate: (
    listener: (event: { preventDefault: () => void }, url: string) => void
  ) => () => void
  readonly setWindowOpenHandler: (handler: (details: { url: string }) => { action: "deny" }) => void
  readonly loadUrl: (url: string) => Effect.Effect<void, unknown>
  readonly loadFile: (path: string) => Effect.Effect<void, unknown>
  readonly isDestroyed: () => boolean
  readonly destroy: () => void
}

export interface CspHost {
  readonly onHeadersReceived: (
    listener: (
      details: { readonly responseHeaders?: Record<string, Array<string>> },
      callback: (response: { readonly responseHeaders: Record<string, string | Array<string>> }) => void
    ) => void
  ) => () => void
}

export interface MainProgramDeps<Port extends PortEndpoint = PortEndpoint> {
  readonly app: DesktopAppHost
  readonly platform: string
  readonly moduleUrl: URL
  readonly createWindow: (options: ReturnType<typeof windowOptions>) => DesktopWindowHost<Port>
  readonly makeMessageChannel: () => { readonly port1: Port; readonly port2: Port }
  readonly csp: CspHost
  readonly makeRuntime: () => DesktopRuntime
}

export type RendererIdentity =
  | { readonly _tag: "url"; readonly value: string }
  | { readonly _tag: "origin"; readonly value: string }

export type DesktopIpcHandlers<R, Port> = IpcHandlersOf<typeof ExpandIpc, R, Port>

export const mainProgram = Effect.fn("DesktopMain.mainProgram")(mainProgramEffect)

const installCsp = Effect.fn("DesktopMain.installCsp")(function* (csp: CspHost) {
  const listener = (
    details: { readonly responseHeaders?: Record<string, Array<string>> },
    callback: (response: { readonly responseHeaders: Record<string, string | Array<string>> }) => void
  ) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [CSP]
      }
    })
  }
  yield* Effect.acquireRelease(
    Effect.sync(() => csp.onHeadersReceived(listener)),
    (dispose) => Effect.sync(dispose)
  )
})

const openWindow = Effect.fn("DesktopMain.openWindow")(function* <Port extends PortEndpoint>(
  deps: MainProgramDeps<Port>,
  runtime: DesktopRuntime,
  devUrl: string | undefined,
  closeWindow: Effect.Effect<void>,
  dispatch: (effect: Effect.Effect<void>) => void
) {
  const path = yield* Path.Path
  const modulePath = yield* path.fromFileUrl(deps.moduleUrl)
  const here = path.dirname(modulePath)
  const browserWindow = yield* Effect.acquireRelease(
    Effect.sync(() => deps.createWindow(windowOptions(path.join(here, "../preload/index.cjs")))),
    (ownedWindow) =>
      Effect.sync(() => {
        if (!ownedWindow.isDestroyed()) ownedWindow.destroy()
      })
  )
  const packagedRendererPath = path.join(here, "../renderer/index.html")
  const packagedRendererUrl = (yield* path.toFileUrl(packagedRendererPath)).href
  const rendererIdentity: RendererIdentity = devUrl === undefined
    ? { _tag: "url", value: packagedRendererUrl }
    : { _tag: "origin", value: new URL(devUrl).origin }
  if (devUrl === undefined) yield* installCsp(deps.csp)
  yield* hardenWebContents({
    onWillNavigate: browserWindow.onWillNavigate,
    setWindowOpenHandler: browserWindow.setWindowOpenHandler,
    isAllowed: (url) => isRendererIdentityAllowed(url, rendererIdentity)
  })
  const ports = yield* wirePortLifecycle({
    onNavigation: browserWindow.onNavigation,
    onClosed: browserWindow.onClosed,
    makeMessageChannel: deps.makeMessageChannel,
    connectPort: (port: MainPortLike) => connectPort({ port, runtime }),
    closeWindow,
    dispatch
  })
  yield* browserWindow.bindIpc(rendererIdentity, { rpcPort: ports.rpcPort })
  if (devUrl === undefined) yield* browserWindow.loadFile(packagedRendererPath)
  else yield* browserWindow.loadUrl(devUrl)
})

function* mainProgramEffect<Port extends PortEndpoint>(deps: MainProgramDeps<Port>) {
  let authorized = false
  const lifecycle = Effect.gen(function* () {
    const devtools = yield* Config.option(Config.string("EXPAND_DEVTOOLS_CDP"))
    const ssh = yield* Config.option(Config.string("SSH_CONNECTION"))
    const renderer = yield* Config.option(Config.string("ELECTRON_RENDERER_URL"))
    const rendererValue = deps.app.isPackaged
      ? undefined
      : Option.getOrUndefined(Option.filter(renderer, (value) => value.length > 0))
    const devUrl = rendererValue === undefined ? undefined : yield* validateDevelopmentUrl(rendererValue)
    if (!deps.app.isPackaged && Option.contains(devtools, "1")) {
      yield* Effect.sync(() => deps.app.appendSwitch("remote-debugging-port", "9222"))
    }
    if (Option.exists(ssh, (value) => value.length > 0)) {
      yield* Effect.sync(deps.app.disableHardwareAcceleration)
    }
    yield* Effect.scoped(
      Effect.gen(function* () {
        const shutdown = yield* Deferred.make<void>()
        const callbackFailure = yield* Deferred.make<Cause.Cause<unknown>>()
        const callbacks = yield* FiberSet.make<unknown, never>()
        const dispatchEffect = yield* FiberSet.runtime(callbacks)<never>()
        let appListenersActive = true
        const beforeQuit = (event: { preventDefault: () => void }) => {
          if (authorized) return
          event.preventDefault()
          if (!appListenersActive) return
          Deferred.doneUnsafe(shutdown, Effect.void)
        }
        const windowAllClosed = () => {
          if (!appListenersActive || deps.platform === "darwin") return
          deps.app.quit()
        }
        yield* Effect.acquireRelease(
          Effect.sync(() => deps.app.onBeforeQuit(beforeQuit)),
          (dispose) => Effect.sync(dispose)
        )
        yield* Effect.acquireRelease(
          Effect.sync(() => deps.app.onWindowAllClosed(windowAllClosed)),
          (dispose) => Effect.sync(dispose)
        )
        yield* Effect.addFinalizer(() => Effect.sync(() => { appListenersActive = false }))
        const runtime = yield* Effect.acquireRelease(
          Effect.sync(deps.makeRuntime),
          (ownedRuntime) => ownedRuntime.disposeEffect
        )
        const ownerScope = yield* Scope.Scope
        const startup = deps.app.ready.pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const windowScope = yield* Scope.fork(ownerScope)
              const closeWindow = yield* Effect.cached(Scope.close(windowScope, Exit.void))
              yield* Scope.addFinalizer(ownerScope, closeWindow)
              yield* openWindow(
                deps,
                runtime,
                devUrl,
                closeWindow,
                (effect) => {
                  dispatchEffect(effect.pipe(
                    Effect.catchCause((cause) => Cause.hasInterruptsOnly(cause)
                      ? Effect.void
                      : Deferred.succeed(callbackFailure, cause))
                  ))
                }
              ).pipe(Scope.provide(windowScope))
              yield* waitFor(shutdown)
            })
          )
        )
        const observedCallbackFailure = Deferred.await(callbackFailure).pipe(
          Effect.flatMap(Effect.failCause)
        )
        yield* Effect.raceFirst(Effect.raceFirst(startup, waitFor(shutdown)), observedCallbackFailure)
      })
    )
  })
  return yield* lifecycle.pipe(
    Effect.ensuring(
      Effect.sync(() => {
        authorized = true
        deps.app.quit()
      })
    )
  )
}

const validateDevelopmentUrl = Effect.fn("DesktopMain.validateDevelopmentUrl")((value: string) =>
  Effect.try({
    try: () => {
      const url = new URL(value)
      if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin === "null") throw new Error(value)
      return url.href
    },
    catch: () => new DesktopMainError({ reason: "invalid-renderer-url", value })
  })
)

const isRendererIdentityAllowed = (value: string, identity: RendererIdentity): boolean => {
  try {
    const parsed = new URL(value)
    return identity._tag === "url" ? parsed.href === identity.value : parsed.origin === identity.value
  } catch {
    return false
  }
}

const waitFor = Deferred.await

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
