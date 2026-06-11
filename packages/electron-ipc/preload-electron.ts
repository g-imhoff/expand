// The ONLY preload-side module that imports "electron". Everything else is pure.
import type { PreloadIpcDeps } from "@yodea/electron-ipc/preload"
import { contextBridge, ipcRenderer } from "electron"
import type { IpcRendererEvent } from "electron"

// Sandboxed preloads run in a DOM context, but the root tsconfig compiles packages/
// without lib.dom — declare the narrow surface we touch.
declare const window: {
  readonly location: { readonly origin: string }
  readonly postMessage: (message: unknown, targetOrigin: string, transfer?: ReadonlyArray<unknown>) => void
}

export const electronPreloadDeps = (): PreloadIpcDeps => {
  // file:// pages have an opaque origin ("null") — there the source+nonce checks
  // on the receiving side are the load-bearing guards (spec §8).
  const targetOrigin = window.location.origin === "null" ? "*" : window.location.origin
  return {
    send: (channel, payload) => ipcRenderer.send(channel, payload),
    invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
    on: (channel, listener) => {
      const wrapped = (event: IpcRendererEvent, payload: unknown) => listener({ ports: event.ports }, payload)
      ipcRenderer.on(channel, wrapped)
      return () => ipcRenderer.removeListener(channel, wrapped)
    },
    exposeInMainWorld: (key, api) => contextBridge.exposeInMainWorld(key, api),
    postToMainWorld: (message, transfer) => window.postMessage(message, targetOrigin, transfer)
  }
}
