import { contextBridge, ipcRenderer } from "electron"

contextBridge.exposeInMainWorld("yodea", {
  listProjects: () => ipcRenderer.invoke("project:list"),
  createProject: (name: string) => ipcRenderer.invoke("project:create", name),
  onProjectsChanged: (cb: (projects: unknown) => void) => {
    const listener = (_e: unknown, projects: unknown) => cb(projects)
    ipcRenderer.on("project:changed", listener)
    return () => ipcRenderer.removeListener("project:changed", listener)
  }
})
