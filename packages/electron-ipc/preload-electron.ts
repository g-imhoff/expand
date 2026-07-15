// The ONLY preload-side module that imports "electron". Everything else is pure.
import type { PreloadIpcDeps } from "@expand/electron-ipc/preload"
import { contextBridge, ipcRenderer } from "electron"
import type { IpcRendererEvent } from "electron"

export const electronPreloadDeps = (): PreloadIpcDeps<MessagePort> => {
  return {
    send: (channel, payload) => ipcRenderer.send(channel, payload),
    invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
    on: (channel, listener) => {
      const wrapped = (event: IpcRendererEvent, payload: unknown) => listener({ ports: event.ports }, payload)
      ipcRenderer.on(channel, wrapped)
      return () => ipcRenderer.removeListener(channel, wrapped)
    },
    exposeInMainWorld: (key, api) => contextBridge.exposeInMainWorld(key, api),
    postToMainWorld: (message, transfer) => {
      // Read the origin per post — origin can change over the preload's lifetime, so a
      // value captured once at setup could go stale. file:// pages have an opaque origin
      // ("null"); there the source+nonce checks on the receiving side are the load-bearing
      // guards (spec §8), and we fall back to "*".
      const origin = window.location.origin
      const targetOrigin = origin === "null" ? "*" : origin
      window.postMessage(message, targetOrigin, [...transfer])
    },
    onContextDisposed: (dispose) => {
      let active = true
      const release = () => {
        if (!active) return
        active = false
        window.removeEventListener("unload", onUnload)
      }
      const onUnload = () => {
        if (!active) return
        release()
        dispose()
      }
      window.addEventListener("unload", onUnload)
      return release
    }
  }
}
