import { it } from "@effect/vitest"
import { Effect, FiberSet } from "effect"
import { beforeEach, describe, expect, vi } from "vitest"
import { electronPreloadDeps } from "@expand/electron-ipc/preload-electron"

const electron = vi.hoisted(() => ({
  send: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  exposeInMainWorld: vi.fn()
}))

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: {
    send: electron.send,
    invoke: electron.invoke,
    on: electron.on,
    removeListener: electron.removeListener
  }
}))

type UnloadListener = () => void

interface FakeWindow {
  readonly location: { readonly origin: string }
  readonly postMessage: ReturnType<typeof vi.fn>
  readonly addEventListener: ReturnType<typeof vi.fn>
  readonly removeEventListener: ReturnType<typeof vi.fn>
  readonly originReads: () => number
  readonly setOrigin: (origin: string) => void
  readonly fireUnload: () => void
  readonly fireRetainedUnload: () => void
}

const makeWindow = (): FakeWindow => {
  let origin = "app://expand"
  let reads = 0
  let active: UnloadListener | undefined
  let retained: UnloadListener | undefined
  const postMessage = vi.fn()
  const addEventListener = vi.fn((_type: string, listener: UnloadListener) => {
    active = listener
    retained = listener
  })
  const removeEventListener = vi.fn((_type: string, listener: UnloadListener) => {
    if (active === listener) active = undefined
  })
  return {
    location: {
      get origin() {
        reads += 1
        return origin
      }
    },
    postMessage,
    addEventListener,
    removeEventListener,
    originReads: () => reads,
    setOrigin: (value: string) => {
      origin = value
    },
    fireUnload: () => {
      active?.()
    },
    fireRetainedUnload: () => {
      retained?.()
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("electron preload adapter", () => {
  it.effect("delegates Electron methods and strips the raw renderer event", () =>
    Effect.gen(function* () {
      const promises = yield* FiberSet.make<unknown, unknown>()
      const runPromise = yield* FiberSet.runtimePromise(promises)<never>()
      electron.invoke.mockImplementation((): unknown =>
        runPromise(Effect.succeed({ _tag: "IpcSuccess", value: 3 })))
      const win = makeWindow()
      vi.stubGlobal("window", win)
      const deps = electronPreloadDeps()
      deps.send("sample:ping", { at: 1 })
      const envelope = yield* Effect.tryPromise(() => deps.invoke("sample:add", { a: 1, b: 2 }))
      const received: Array<unknown> = []
      const release = deps.on("sample:tick", (event, payload) => {
        received.push(event, payload)
      })
      const wrapped = electron.on.mock.calls[0]?.[1]
      const rawEvent = { ports: [{ port: true }], sender: { secret: true } }
      wrapped(rawEvent, { seq: 1 })
      release()
      deps.exposeInMainWorld("sample", { ping: true })
      expect(envelope).toEqual({ _tag: "IpcSuccess", value: 3 })
      expect(electron.send).toHaveBeenCalledWith("sample:ping", { at: 1 })
      expect(electron.invoke).toHaveBeenCalledWith("sample:add", { a: 1, b: 2 })
      expect(received).toEqual([{ ports: rawEvent.ports }, { seq: 1 }])
      expect(received).not.toContain(rawEvent)
      expect(electron.removeListener).toHaveBeenCalledWith("sample:tick", wrapped)
      expect(electron.exposeInMainWorld).toHaveBeenCalledWith("sample", { ping: true })
      vi.unstubAllGlobals()
    }))

  it.effect("reads the current origin once per post and preserves opaque origin fallback", () =>
    Effect.sync(() => {
      const win = makeWindow()
      vi.stubGlobal("window", win)
      const deps = electronPreloadDeps()
      const firstPort = { first: true } as unknown as MessagePort
      deps.postToMainWorld({ index: 1 }, [firstPort])
      win.setOrigin("null")
      const secondPort = { second: true } as unknown as MessagePort
      deps.postToMainWorld({ index: 2 }, [secondPort])
      expect(win.originReads()).toBe(2)
      expect(win.postMessage.mock.calls).toEqual([
        [{ index: 1 }, "app://expand", [firstPort]],
        [{ index: 2 }, "*", [secondPort]]
      ])
      vi.unstubAllGlobals()
    }))

  it.effect("registers and removes one exact unload callback idempotently", () =>
    Effect.sync(() => {
      const win = makeWindow()
      vi.stubGlobal("window", win)
      const deps = electronPreloadDeps()
      const disposed = vi.fn()
      const release = deps.onContextDisposed(disposed)
      const listener = win.addEventListener.mock.calls[0]?.[1]
      expect(win.addEventListener).toHaveBeenCalledWith("unload", listener)
      release()
      release()
      win.fireRetainedUnload()
      expect(win.removeEventListener).toHaveBeenCalledTimes(1)
      expect(win.removeEventListener).toHaveBeenCalledWith("unload", listener)
      expect(disposed).not.toHaveBeenCalled()

      const disposedFromUnload = vi.fn()
      const releaseFromUnload = deps.onContextDisposed(disposedFromUnload)
      const unloadListener = win.addEventListener.mock.calls[1]?.[1]
      win.fireUnload()
      releaseFromUnload()
      win.fireRetainedUnload()
      expect(disposedFromUnload).toHaveBeenCalledTimes(1)
      expect(win.removeEventListener).toHaveBeenCalledTimes(2)
      expect(win.removeEventListener).toHaveBeenLastCalledWith("unload", unloadListener)
      vi.unstubAllGlobals()
    }))
})
