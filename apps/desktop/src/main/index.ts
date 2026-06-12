import { app, BrowserWindow, MessageChannelMain, session } from "electron"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import type { ProjectStore } from "@yodea/client-core"
import { bindIpc } from "@yodea/electron-ipc/main"
import { electronBindDeps } from "@yodea/electron-ipc/main-electron"
import { makeRuntime } from "@yodea/desktop/main/runtime"
import { connectPort } from "@yodea/desktop/main/rpc/transport"
import { hardenWebContents } from "@yodea/desktop/main/security/harden-web-contents"
import { windowOptions } from "@yodea/desktop/main/security/window-options"
import { originRulesFor } from "@yodea/desktop/main/ipc/origin-rules"
import { wirePortLifecycle } from "@yodea/desktop/main/ipc/port-lifecycle"
import { YodeaIpc } from "@yodea/desktop/shared/ipc/channels"

const here = dirname(fileURLToPath(import.meta.url))

if (!app.isPackaged && process.env["YODEA_DEVTOOLS_CDP"] === "1") {
  app.commandLine.appendSwitch("remote-debugging-port", "9222")
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
  // Explicit type params: the rpcPort handler is `Effect.sync` (R = never), so
  // inference leaves bindIpc's R as `unknown`, which then fights runtime.runPromise
  // (R = ProjectStore). Pin R/Port to the real services and transferable port type.
  const bound = bindIpc<typeof YodeaIpc, ProjectStore, Electron.MessagePortMain>(
    YodeaIpc,
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
