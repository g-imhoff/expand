import { ipcMain } from "electron"
import type { MessagePortMain } from "electron"
import type { FrameLike, IpcMainLike, WindowTargetLike } from "@expand/electron-ipc/main"

export interface ElectronBindDeps {
  readonly ipc: IpcMainLike
  readonly target: WindowTargetLike<MessagePortMain>
}

export interface ElectronWindowLike {
  readonly webContents: {
    readonly mainFrame: FrameLike
    readonly postMessage: (
      channel: string,
      message: unknown,
      transfer?: Array<MessagePortMain>
    ) => void
  }
}

export const electronBindDeps = (win: ElectronWindowLike): ElectronBindDeps => ({
  ipc: {
    on: (channel, listener) => {
      const wrapper = (event: { sender: unknown; senderFrame: FrameLike | null }, payload: unknown) =>
        listener({ sender: event.sender, senderFrame: toFrameLike(event.senderFrame) }, payload)
      ipcMain.on(channel, wrapper)
      let disposed = false
      return () => {
        if (disposed) return
        disposed = true
        ipcMain.off(channel, wrapper)
      }
    },
    handle: (channel, handler) => {
      const wrapper = (event: { sender: unknown; senderFrame: FrameLike | null }, payload: unknown): Promise<unknown> =>
        handler({ sender: event.sender, senderFrame: toFrameLike(event.senderFrame) }, payload)
      ipcMain.handle(channel, wrapper)
      let disposed = false
      return () => {
        if (disposed) return
        disposed = true
        ipcMain.removeHandler(channel)
      }
    }
  },
  target: {
    webContents: win.webContents,
    get mainFrame(): FrameLike | null {
      return toFrameLike(win.webContents.mainFrame)
    },
    postToRenderer: (channel, payload, transfer) =>
      win.webContents.postMessage(channel, payload, [...transfer])
  }
})

const toFrameLike = (frame: FrameLike | null): FrameLike | null => {
  if (frame === null) return null
  return frame
}
