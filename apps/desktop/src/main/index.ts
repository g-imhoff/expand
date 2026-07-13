import { app, BrowserWindow, MessageChannelMain, session } from "electron"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import type { ClientSession } from "@expand/client-ts"
import type { ProjectClient } from "@expand/client-ts/project"
import type { ServerClient } from "@expand/client-ts/server"
import { bindIpc } from "@expand/electron-ipc/main"
import { electronBindDeps } from "@expand/electron-ipc/main-electron"
import { makeRuntime } from "@expand/desktop/main/runtime"
import { connectPort } from "@expand/desktop/main/rpc/transport"
import { hardenWebContents } from "@expand/desktop/main/security/harden-web-contents"
import { windowOptions } from "@expand/desktop/main/security/window-options"
import { originRulesFor } from "@expand/desktop/main/ipc/origin-rules"
import { wirePortLifecycle } from "@expand/desktop/main/ipc/port-lifecycle"
import { ExpandIpc } from "@expand/desktop/shared/ipc/channels"

const here = dirname(fileURLToPath(import.meta.url))

if (!app.isPackaged && process.env["EXPAND_DEVTOOLS_CDP"] === "1") {
  app.commandLine.appendSwitch("remote-debugging-port", "9222")
}

// GPU-less remote dev over forwarded X11: SwiftShader software-GL wastes VPS CPU
if (process.env["SSH_CONNECTION"]) {
  app.disableHardwareAcceleration()
}

const runtime = makeRuntime()

const devUrl = process.env["ELECTRON_RENDERER_URL"]
const isAllowedNavigation = (url: string): boolean =>
  devUrl ? url.startsWith(devUrl) : url.startsWith("file://")

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"

const installCsp = () => {
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [CSP] } })
  })
}

const createWindow = () => {
  const win = new BrowserWindow(windowOptions(join(here, "../preload/index.cjs")))

  hardenWebContents({
    onWillNavigate: (cb) => win.webContents.on("will-navigate", (e, url) => cb(e, url)),
    setWindowOpenHandler: (handler) => win.webContents.setWindowOpenHandler(handler),
    isAllowed: isAllowedNavigation
  })

  let currentTeardown: (() => Promise<void>) | undefined
  const teardownPort = () => {
    if (currentTeardown) {
      void currentTeardown()
      currentTeardown = undefined
    }
  }

  const { ipc, target } = electronBindDeps(win)
  const bound = bindIpc<
    typeof ExpandIpc,
    ClientSession | ProjectClient | ServerClient,
    Electron.MessagePortMain
  >(
    ExpandIpc,
    {
      rpcPort: () =>
        Effect.sync(() => {
          teardownPort() // supersede: a new request invalidates the previous port
          const { port1, port2 } = new MessageChannelMain()
          currentTeardown = connectPort({ port: port1, runtime })
          return port2
        })
    },
    {
      ipc,
      target,
      originRules: originRulesFor(devUrl),
      runPromise: (effect) => runtime.runPromise(effect),
      log: (message) => console.warn(message)
    }
  )

  wirePortLifecycle({
    onNavigation: (cb) =>
      win.webContents.on("did-start-navigation", (details) => cb({ isSameDocument: details.isSameDocument })),
    onClosed: (cb) => win.on("closed", cb),
    teardownPort,
    unbind: bound.unbind
  })

  if (devUrl) win.loadURL(devUrl)
  else win.loadFile(join(here, "../renderer/index.html"))
}

app.whenReady().then(() => {
  if (!devUrl) installCsp()
  createWindow()
})

app.on("before-quit", () => {
  void runtime.dispose()
})
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
