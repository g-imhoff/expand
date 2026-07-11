// packages/electron-ipc/main-electron.ts
// The ONLY main-side module that imports "electron". Narrows real Electron
// objects to the structural interfaces of main.ts (same idiom as MainPortLike).
import { ipcMain } from "electron"
import type { BrowserWindow, MessagePortMain, WebFrameMain } from "electron"
import type { FrameLike, IpcMainLike, WindowTargetLike } from "@expand/electron-ipc/main"

export interface ElectronBindDeps {
  readonly ipc: IpcMainLike
  readonly target: WindowTargetLike
}

export const electronBindDeps = (win: BrowserWindow): ElectronBindDeps => ({
  ipc: {
    on: (channel, listener) =>
      ipcMain.on(channel, (event, payload: unknown) =>
        listener({ sender: event.sender, senderFrame: toFrameLike(event.senderFrame) }, payload)
      ),
    // Electron's removeListener removes by reference; our wrapper breaks that, so
    // unbind clears the whole channel instead — safe because the registry is the
    // only writer on expand:* channels (architecture-tested).
    removeListener: (channel) => ipcMain.removeAllListeners(channel),
    handle: (channel, handler) =>
      ipcMain.handle(channel, (event, payload: unknown) =>
        handler({ sender: event.sender, senderFrame: toFrameLike(event.senderFrame) }, payload)
      ),
    removeHandler: (channel) => ipcMain.removeHandler(channel)
  },
  target: {
    webContents: win.webContents,
    get mainFrame(): FrameLike | null {
      return toFrameLike(win.webContents.mainFrame)
    },
    postToRenderer: (channel, payload, transfer) =>
      win.webContents.postMessage(channel, payload, transfer as Array<MessagePortMain>)
  }
})

const toFrameLike = (frame: WebFrameMain | null): FrameLike | null => {
  if (frame === null) return null
  // WebFrameMain.detached: frames can detach after any await (Electron 33+).
  if (frame.detached) return { url: "", detached: true }
  return frame as unknown as FrameLike // structural: { url, detached } — same object keeps reference equality for the main-frame check
}
