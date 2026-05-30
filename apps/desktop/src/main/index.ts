import { app, BrowserWindow, ipcMain } from "electron"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { makeRuntime } from "@yodea/desktop/main/runtime"
import { registerIpc } from "@yodea/desktop/main/ipc"

// electron-vite builds this main process as ESM (out/main/index.mjs), where the
// CJS global __dirname is undefined. Derive it from import.meta.url instead.
const here = dirname(fileURLToPath(import.meta.url))

// Dev only: expose the renderer's Chromium devtools so an AI browser agent can
// attach over CDP to drive/verify the GUI.
if (!app.isPackaged) {
  app.commandLine.appendSwitch("remote-debugging-port", "9222")
}

const runtime = makeRuntime()

const createWindow = () => {
  const win = new BrowserWindow({
    width: 900,
    height: 640,
    webPreferences: {
      preload: join(here, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  registerIpc({
    handle: (channel, fn) => ipcMain.handle(channel, fn),
    runtime,
    send: (channel, payload) => win.webContents.send(channel, payload)
  })

  // electron-vite injects the dev server URL; falls back to the built file.
  const devUrl = process.env["ELECTRON_RENDERER_URL"]
  if (devUrl) win.loadURL(devUrl)
  else win.loadFile(join(here, "../renderer/index.html"))
}

app.whenReady().then(createWindow)
app.on("window-all-closed", () => {
  runtime.dispose().finally(() => {
    if (process.platform !== "darwin") app.quit()
  })
})
