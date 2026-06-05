import { app, BrowserWindow, ipcMain, MessageChannelMain, session } from "electron"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { makeRuntime } from "@yodea/desktop/main/runtime"
import { connectPort } from "@yodea/desktop/main/rpc/transport"
import { hardenWebContents } from "@yodea/desktop/main/security/harden-web-contents"

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

  let currentTeardown: (() => Promise<void>) | undefined
  const onPortRequest = (e: Electron.IpcMainEvent) => {
    if (e.sender !== win.webContents) return
    if (currentTeardown) void currentTeardown()
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
  if (!devUrl) installCsp()
  createWindow()
})

app.on("before-quit", () => {
  void runtime.dispose()
})
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
