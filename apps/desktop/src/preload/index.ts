import { contextBridge, ipcRenderer } from "electron"

// The preload's ONLY job: broker the MessagePort. The renderer calls requestPort()
// on mount; main replies with a transferred port which we forward to the page via
// window.postMessage (a live MessagePort cannot cross contextBridge — only plain
// values can — so it is transferred natively here). Sandbox-safe (CommonJS preload).
ipcRenderer.on("yodea:port", (event) => {
  window.postMessage("yodea:port", "*", event.ports)
})

contextBridge.exposeInMainWorld("yodea", {
  requestPort: () => ipcRenderer.send("yodea:port-request")
})
