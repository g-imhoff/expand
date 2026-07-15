import {
  app,
  BrowserWindow,
  MessageChannelMain,
  session
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
import { Effect } from "effect"
import { electronBindDeps } from "@expand/electron-ipc/main-electron"
import { makeRuntime } from "@expand/desktop/main/runtime"
import {
  mainProgram,
  type CspHost,
  type DesktopAppHost,
  type DesktopWindowHost,
  type MainProgramDeps
} from "@expand/desktop/main/program"

const appHost: DesktopAppHost = {
  isPackaged: app.isPackaged,
  ready: Effect.tryPromise(() => app.whenReady()),
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
  return {
    ipc: electronBindDeps(browserWindow),
    onClosed: (listener) => {
      browserWindow.on("closed", listener)
      let disposed = false
      return () => {
        if (disposed) return
        disposed = true
        browserWindow.off("closed", listener)
      }
    },
    onNavigation: (listener) => {
      const wrapped = (details: Event<WebContentsDidStartNavigationEventParams>) =>
        listener({ isSameDocument: details.isSameDocument })
      browserWindow.webContents.on("did-start-navigation", wrapped)
      let disposed = false
      return () => {
        if (disposed) return
        disposed = true
        browserWindow.webContents.off("did-start-navigation", wrapped)
      }
    },
    onWillNavigate: (listener) => {
      const wrapped = (details: Event<WebContentsWillNavigateEventParams>) => listener(details, details.url)
      browserWindow.webContents.on("will-navigate", wrapped)
      let disposed = false
      return () => {
        if (disposed) return
        disposed = true
        browserWindow.webContents.off("will-navigate", wrapped)
      }
    },
    setWindowOpenHandler: (handler) => browserWindow.webContents.setWindowOpenHandler(handler),
    loadUrl: (url) => Effect.tryPromise(() => browserWindow.loadURL(url)),
    loadFile: (path) => Effect.tryPromise(() => browserWindow.loadFile(path)),
    isDestroyed: () => browserWindow.isDestroyed(),
    destroy: () => browserWindow.destroy()
  }
}

const deps: MainProgramDeps<MessagePortMain> = {
  app: appHost,
  platform: process.platform,
  moduleUrl: new URL(import.meta.url),
  createWindow,
  makeMessageChannel: () => new MessageChannelMain(),
  csp,
  makeRuntime,
  log: (message, cause) =>
    cause === undefined ? Effect.logWarning(message) : Effect.logWarning(message, cause)
}

NodeRuntime.runMain(mainProgram(deps).pipe(Effect.provide(NodePath.layer)))
