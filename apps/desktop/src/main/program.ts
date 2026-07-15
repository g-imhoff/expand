import {
  Config,
  Deferred,
  Effect,
  Exit,
  FiberSet,
  Option,
  Path,
  Scope
} from "effect"
import type { Cause } from "effect"
import type { IpcMainLike, WindowTargetLike } from "@expand/electron-ipc/main"
import { bindIpc } from "@expand/electron-ipc/main"
import type { MainPortLike } from "@expand/desktop/main/rpc/server"
import { connectPort, type RpcRuntime } from "@expand/desktop/main/rpc/transport"
import {
  wirePortLifecycle,
  type PortEndpoint
} from "@expand/desktop/main/ipc/port-lifecycle"
import { hardenWebContents } from "@expand/desktop/main/security/harden-web-contents"
import { windowOptions } from "@expand/desktop/main/security/window-options"
import { originRulesFor } from "@expand/desktop/main/ipc/origin-rules"
import { ExpandIpc } from "@expand/desktop/shared/ipc/channels"

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

export interface DesktopWindowHost<Port extends PortEndpoint> {
  readonly ipc: {
    readonly ipc: IpcMainLike
    readonly target: WindowTargetLike<Port>
  }
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
  readonly log: (message: string, cause: Cause.Cause<unknown> | undefined) => Effect.Effect<void>
}

export const installCsp = Effect.fn("DesktopMain.installCsp")(function* (csp: CspHost) {
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

export const openWindow = Effect.fn("DesktopMain.openWindow")(function* <Port extends PortEndpoint>(
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
  if (devUrl === undefined) yield* installCsp(deps.csp)
  yield* hardenWebContents({
    onWillNavigate: browserWindow.onWillNavigate,
    setWindowOpenHandler: browserWindow.setWindowOpenHandler,
    isAllowed: (url) => devUrl === undefined ? url.startsWith("file://") : url.startsWith(devUrl)
  })
  const ports = yield* wirePortLifecycle({
    onNavigation: browserWindow.onNavigation,
    onClosed: browserWindow.onClosed,
    makeMessageChannel: deps.makeMessageChannel,
    connectPort: (port: MainPortLike) => connectPort({ port, runtime }),
    closeWindow,
    dispatch
  })
  yield* bindIpc(
    ExpandIpc,
    { rpcPort: ports.rpcPort },
    {
      ipc: browserWindow.ipc.ipc,
      target: browserWindow.ipc.target,
      originRules: originRulesFor(devUrl),
      log: deps.log
    }
  )
  if (devUrl === undefined) yield* browserWindow.loadFile(path.join(here, "../renderer/index.html"))
  else yield* browserWindow.loadUrl(devUrl)
})

export const mainProgram = Effect.fn("DesktopMain.mainProgram")(function* <Port extends PortEndpoint>(
  deps: MainProgramDeps<Port>
) {
  let authorized = false
  const lifecycle = Effect.gen(function* () {
    const devtools = yield* Config.option(Config.string("EXPAND_DEVTOOLS_CDP"))
    const ssh = yield* Config.option(Config.string("SSH_CONNECTION"))
    const renderer = yield* Config.option(Config.string("ELECTRON_RENDERER_URL"))
    const devUrl = Option.getOrUndefined(Option.filter(renderer, (value) => value.length > 0))
    if (!deps.app.isPackaged && Option.contains(devtools, "1")) {
      yield* Effect.sync(() => deps.app.appendSwitch("remote-debugging-port", "9222"))
    }
    if (Option.exists(ssh, (value) => value.length > 0)) {
      yield* Effect.sync(deps.app.disableHardwareAcceleration)
    }
    yield* Effect.scoped(
      Effect.gen(function* () {
        const shutdown = yield* Deferred.make<void>()
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
                (effect) => { dispatchEffect(effect) }
              ).pipe(Scope.provide(windowScope))
              yield* waitFor(shutdown)
            })
          )
        )
        yield* Effect.raceFirst(startup, waitFor(shutdown))
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
})

const waitFor = Deferred.await

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
