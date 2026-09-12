import {
  app,
  BrowserWindow,
  MessageChannelMain,
  session,
  utilityProcess
} from "electron"
import type {
  Event,
  HeadersReceivedResponse,
  MessagePortMain,
  OnHeadersReceivedListenerDetails,
  WebContentsDidStartNavigationEventParams,
  WebContentsWillNavigateEventParams
} from "electron"
import { NodePath, NodeRuntime } from "@effect/platform-node"
import { join } from "node:path"
import { Effect } from "effect"
import { appVersion } from "@expand/contracts/build-info"
import { BackendUnavailable } from "@expand/client-ts"
import { bindElectronIpc } from "@expand/electron-ipc/main"
import { ExpandIpc } from "@expand/desktop/shared/ipc/channels"
import { makeRuntime } from "@expand/desktop/main/runtime/client-runtime"
import {
  DesktopMainError,
  type DesktopIpcHandlers,
  mainProgram,
  type RendererIdentity,
  type CspHost,
  type DesktopAppHost,
  type DesktopWindowHost,
  type MainProgramDeps
} from "@expand/desktop/main/application/main-program"

const appHost: DesktopAppHost = {
  isPackaged: app.isPackaged,
  ready: Effect.tryPromise(() => app.whenReady()).pipe(
    Effect.mapError((cause) => new DesktopMainError({ reason: "host", cause }))
  ),
  appendSwitch: (name, value) => app.commandLine.appendSwitch(name, value),
  disableHardwareAcceleration: () => app.disableHardwareAcceleration(),
  onBeforeQuit: (listener) => {
    const wrapped = (event: Event) => listener(event)
    app.on("before-quit", wrapped)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      app.off("before-quit", wrapped)
    }
  },
  onWindowAllClosed: (listener) => {
    app.on("window-all-closed", listener)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      app.off("window-all-closed", listener)
    }
  },
  onActivate: (listener) => {
    app.on("activate", listener)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      app.off("activate", listener)
    }
  },
  quit: () => app.quit()
}

const csp: CspHost = {
  onHeadersReceived: (listener) => {
    const wrapped = (
      details: OnHeadersReceivedListenerDetails,
      callback: (response: HeadersReceivedResponse) => void
    ) => listener(details, callback)
    session.defaultSession.webRequest.onHeadersReceived(wrapped)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      session.defaultSession.webRequest.onHeadersReceived(null)
    }
  }
}

const createWindow = (options: ConstructorParameters<typeof BrowserWindow>[0]): DesktopWindowHost<MessagePortMain> => {
  const browserWindow = new BrowserWindow(options)
  const webContents = browserWindow.webContents
  return {
    bindIpc: <R>(identity: RendererIdentity, handlers: DesktopIpcHandlers<R, MessagePortMain>) =>
      bindElectronIpc<typeof ExpandIpc, R>(
        ExpandIpc,
        handlers,
        identity._tag === "url"
          ? { window: browserWindow, rendererUrl: identity.value }
          : { window: browserWindow, rendererOrigin: identity.value }
      ).pipe(Effect.asVoid),
    onClosed: (listener) => {
      browserWindow.on("closed", listener)
      let disposed = false
      return () => {
        if (disposed) return
        disposed = true
        if (!browserWindow.isDestroyed()) browserWindow.off("closed", listener)
      }
    },
    onNavigation: (listener) => {
      const wrapped = (details: Event<WebContentsDidStartNavigationEventParams>) =>
        listener({ isSameDocument: details.isSameDocument })
      webContents.on("did-start-navigation", wrapped)
      let disposed = false
      return () => {
        if (disposed) return
        disposed = true
        if (!webContents.isDestroyed()) webContents.off("did-start-navigation", wrapped)
      }
    },
    onWillNavigate: (listener) => {
      const wrapped = (details: Event<WebContentsWillNavigateEventParams>) => listener(details, details.url)
      webContents.on("will-navigate", wrapped)
      let disposed = false
      return () => {
        if (disposed) return
        disposed = true
        if (!webContents.isDestroyed()) webContents.off("will-navigate", wrapped)
      }
    },
    setWindowOpenHandler: (handler) => webContents.setWindowOpenHandler(handler),
    loadUrl: (url) => Effect.tryPromise(() => browserWindow.loadURL(url)).pipe(
      Effect.mapError((cause) => new DesktopMainError({ reason: "host", cause }))
    ),
    loadFile: (path) => Effect.tryPromise(() => browserWindow.loadFile(path)).pipe(
      Effect.mapError((cause) => new DesktopMainError({ reason: "host", cause }))
    ),
    isDestroyed: () => browserWindow.isDestroyed(),
    destroy: () => browserWindow.destroy()
  }
}

const packagedBackends = new Set<ReturnType<typeof utilityProcess.fork>>()
const packagedBackendWaiters = new Set<() => void>()

const spawnPackagedBackend = (backendEntry: string, dataDir: string) => Effect.try({
  try: () => {
    const child = utilityProcess.fork(
      backendEntry,
      ["--data-dir", dataDir],
      { serviceName: "Expand Backend", stdio: "ignore" }
    )
    packagedBackends.add(child)
    child.once("exit", () => {
      packagedBackends.delete(child)
      if (packagedBackends.size === 0) {
        for (const wake of packagedBackendWaiters) wake()
      }
    })
  },
  catch: (cause) => new BackendUnavailable({
    reason: `spawn failed: ${backendEntry}: ${String(cause)}`,
    cause
  })
})

const awaitPackagedBackendShutdown = Effect.callback<void>((resume) => {
  if (packagedBackends.size === 0) {
    resume(Effect.void)
    return
  }
  const wake = () => {
    packagedBackendWaiters.delete(wake)
    resume(Effect.void)
  }
  packagedBackendWaiters.add(wake)
  return Effect.sync(() => packagedBackendWaiters.delete(wake))
}).pipe(
  Effect.timeoutOrElse({
    duration: "5 seconds",
    orElse: () => Effect.sync(() => {
      for (const child of packagedBackends) child.kill()
    })
  })
)

const deps: MainProgramDeps<MessagePortMain> = {
  app: appHost,
  platform: process.platform,
  moduleUrl: new URL(import.meta.url),
  createWindow,
  makeMessageChannel: () => new MessageChannelMain(),
  csp,
  makeRuntime: () => makeRuntime({
    backendEntry: join(app.getAppPath(), "build", "backend.mjs"),
    isPackaged: app.isPackaged,
    moduleUrl: new URL(import.meta.url),
    awaitPackagedBackendShutdown,
    spawnPackagedBackend
  })
}

NodeRuntime.runMain(
  Effect.logInfo("starting Expand desktop", { appVersion }).pipe(
    Effect.andThen(mainProgram(deps)),
    Effect.provide(NodePath.layer)
  )
)
