import { app, BrowserWindow, ipcMain, MessageChannelMain, session } from "electron"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { makeRuntime } from "@yodea/desktop/main/runtime"
import { connectPort } from "@yodea/desktop/main/rpc/transport"
import { hardenWebContents } from "@yodea/desktop/main/security/harden-web-contents"

const here = dirname(fileURLToPath(import.meta.url))

// Dev only, and only when explicitly opted in: expose the renderer's Chromium
// devtools so an AI browser agent can attach over CDP. Loopback is not an auth
// boundary, so gate behind an env flag in addition to !isPackaged.
if (!app.isPackaged && process.env["YODEA_DEVTOOLS_CDP"] === "1") {
  app.commandLine.appendSwitch("remote-debugging-port", "9222")
}

const runtime = makeRuntime()

// The renderer origin we permit navigation to: the electron-vite dev server in
// dev, or our packaged file. Everything else is blocked by hardenWebContents.
const devUrl = process.env["ELECTRON_RENDERER_URL"]
const isAllowedNavigation = (url: string): boolean =>
  devUrl ? url.startsWith(devUrl) : url.startsWith("file://")

// Strict CSP for the renderer. The renderer opens no sockets (main does), so
// connect-src 'self' is sufficient.
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"

const installCsp = () => {
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [CSP] } })
  })
}

const createWindow = () => {
  const win = new BrowserWindow({
    width: 980,
    height: 700,
    webPreferences: {
      preload: join(here, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  hardenWebContents({
    onWillNavigate: (cb) => win.webContents.on("will-navigate", (e, url) => cb(e, url)),
    setWindowOpenHandler: (handler) => win.webContents.setWindowOpenHandler(handler),
    isAllowed: isAllowedNavigation
  })

  // The renderer requests a port on mount (survives reload: each load re-requests
  // and we re-mint). One MessageChannelMain per request; the renderer end (port2)
  // is transferred to the window; the main end (port1) drives a per-window RpcServer.
  // `currentTeardown` holds this window's live port teardown, captured in closure so
  // the `closed` handler never reads the (by then destroyed) webContents.
  let currentTeardown: (() => Promise<void>) | undefined
  const onPortRequest = (e: Electron.IpcMainEvent) => {
    if (e.sender !== win.webContents) return
    if (currentTeardown) void currentTeardown() // reload: tear down the previous port first
    const { port1, port2 } = new MessageChannelMain()
    currentTeardown = connectPort({ port: port1, runtime })
    win.webContents.postMessage("yodea:port", null, [port2])
  }
  ipcMain.on("yodea:port-request", onPortRequest)

  win.on("closed", () => {
    ipcMain.removeListener("yodea:port-request", onPortRequest)
    if (currentTeardown) void currentTeardown()
  })

  if (devUrl) win.loadURL(devUrl)
  else win.loadFile(join(here, "../renderer/index.html"))
}

app.whenReady().then(() => {
  // Strict CSP for the PACKAGED renderer only. In dev the renderer is served by
  // the electron-vite dev server, whose HMR / React-refresh needs eval + a ws
  // connection back to the dev origin — the strict CSP would break it. Dev is a
  // trusted local origin; the security-relevant (packaged) build keeps the CSP.
  if (!devUrl) installCsp()
  createWindow()
})

// One runtime for the whole app: dispose ONCE at quit, not per window.
app.on("before-quit", () => {
  void runtime.dispose()
})
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
