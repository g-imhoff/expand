import { contextBridge, ipcRenderer } from "electron"

ipcRenderer.on("yodea:port", (event) => {
  window.postMessage("yodea:port", "*", event.ports)
})

contextBridge.exposeInMainWorld("yodea", {
  requestPort: () => ipcRenderer.send("yodea:port-request")
})
