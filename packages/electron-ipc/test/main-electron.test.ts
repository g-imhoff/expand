import { describe, expect, it, vi } from "vitest"
import { electronBindDeps } from "@expand/electron-ipc/main-electron"

const electron = vi.hoisted(() => {
  const listeners = new Map<string, (event: { sender: unknown; senderFrame: unknown }, payload: unknown) => void>()
  const handlers = new Map<string, (event: { sender: unknown; senderFrame: unknown }, payload: unknown) => unknown>()
  const removedListeners: Array<{ channel: string; listener: unknown }> = []
  const removedHandlers: Array<string> = []
  return {
    listeners,
    handlers,
    removedListeners,
    removedHandlers,
    ipcMain: {
      on: (channel: string, listener: (event: { sender: unknown; senderFrame: unknown }, payload: unknown) => void) => {
        listeners.set(channel, listener)
      },
      off: (channel: string, listener: unknown) => {
        removedListeners.push({ channel, listener })
        if (listeners.get(channel) === listener) listeners.delete(channel)
      },
      handle: (channel: string, handler: (event: { sender: unknown; senderFrame: unknown }, payload: unknown) => unknown) => {
        handlers.set(channel, handler)
      },
      removeHandler: (channel: string) => {
        removedHandlers.push(channel)
        handlers.delete(channel)
      }
    }
  }
})

vi.mock("electron", () => ({ ipcMain: electron.ipcMain }))

describe("electronBindDeps", () => {
  it("removes the exact stable listener wrapper once", () => {
    const frame = { url: "file:///app/index.html", detached: false }
    const webContents = { mainFrame: frame, postMessage: vi.fn() }
    const deps = electronBindDeps({ webContents })
    const admitted: Array<unknown> = []
    const listener = (event: unknown) => { admitted.push(event) }
    const dispose = deps.ipc.on("sample:send", listener)
    const wrapper = electron.listeners.get("sample:send")
    expect(wrapper).toBeDefined()
    expect(wrapper).not.toBe(listener)
    wrapper?.({ sender: webContents, senderFrame: frame }, { value: 1 })
    expect(admitted).toEqual([{ sender: webContents, senderFrame: frame }])
    dispose()
    dispose()
    expect(electron.removedListeners).toEqual([{ channel: "sample:send", listener: wrapper }])
  })

  it("removes only its invoke handler once", () => {
    const frame = { url: "file:///app/index.html", detached: false }
    const webContents = { mainFrame: frame, postMessage: vi.fn() }
    const deps = electronBindDeps({ webContents })
    const dispose = deps.ipc.handle("sample:invoke", () => { throw new Error("unused") })
    expect(electron.handlers.has("sample:invoke")).toBe(true)
    dispose()
    dispose()
    expect(electron.removedHandlers).toEqual(["sample:invoke"])
  })
})
