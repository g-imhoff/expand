import { it } from "@effect/vitest"
import { Effect, FiberSet, Schema } from "effect"
import { beforeEach, describe, expect, vi } from "vitest"
import { IpcChannel, IpcContract } from "@expand/electron-ipc/contract"
import { exposeBridge } from "@expand/electron-ipc/preload"
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

const AdapterContract = IpcContract.make("adapter", {
  tick: IpcChannel.event({ payload: Schema.Struct({ seq: Schema.Number }) }),
  rpcPort: IpcChannel.portExchange()
})

type UnloadListener = () => void

interface WindowOptions {
  readonly removeError?: Error
}

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

const makeWindow = (options: WindowOptions = {}): FakeWindow => {
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
    if (options.removeError !== undefined) throw options.removeError
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

const captureThrow = (operation: () => unknown): unknown => {
  try {
    operation()
  } catch (error) {
    return error
  }
  throw new Error("operation did not throw")
}

beforeEach(() => {
  vi.clearAllMocks()
  electron.removeListener.mockImplementation(() => undefined)
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

  it.effect("attempts disposal before a failing unload release exactly once", () =>
    Effect.sync(() => {
      const removalCause = new Error("unload removal failed")
      const win = makeWindow({ removeError: removalCause })
      vi.stubGlobal("window", win)
      const deps = electronPreloadDeps()
      const disposed = vi.fn()
      const release = deps.onContextDisposed(disposed)
      expect(captureThrow(win.fireUnload)).toBe(removalCause)
      expect(disposed).toHaveBeenCalledTimes(1)
      expect(disposed.mock.invocationCallOrder[0]).toBeLessThan(win.removeEventListener.mock.invocationCallOrder[0]!)
      release()
      win.fireUnload()
      win.fireRetainedUnload()
      expect(disposed).toHaveBeenCalledTimes(1)
      expect(win.removeEventListener).toHaveBeenCalledTimes(1)
      vi.unstubAllGlobals()
    }))

  it.effect("aggregates independent unload disposal and removal failures in operation order", () =>
    Effect.sync(() => {
      const disposalCause = new Error("disposal failed")
      const removalCause = new Error("unload removal failed")
      const win = makeWindow({ removeError: removalCause })
      vi.stubGlobal("window", win)
      const deps = electronPreloadDeps()
      const disposed = vi.fn(() => {
        throw disposalCause
      })
      const release = deps.onContextDisposed(disposed)
      const thrown = captureThrow(win.fireUnload)
      expect(thrown).toBeInstanceOf(AggregateError)
      if (!(thrown instanceof AggregateError)) throw thrown
      expect(thrown.errors).toEqual([disposalCause, removalCause])
      release()
      win.fireUnload()
      win.fireRetainedUnload()
      expect(disposed).toHaveBeenCalledTimes(1)
      expect(win.removeEventListener).toHaveBeenCalledTimes(1)
      vi.unstubAllGlobals()
    }))

  it.effect("deactivates the bridge and attempts every Electron release when unload removal fails", () =>
    Effect.sync(() => {
      const removalCause = new Error("unload removal failed")
      const win = makeWindow({ removeError: removalCause })
      vi.stubGlobal("window", win)
      const dispose = exposeBridge(AdapterContract, "adapter", electronPreloadDeps())
      const api = electron.exposeInMainWorld.mock.calls[0]?.[1]
      const received: Array<unknown> = []
      const releaseEvent = api.tick((payload: unknown) => {
        received.push(payload)
      })
      const grantListener = electron.on.mock.calls.find(([channel]) => channel === "adapter:rpcPort:grant")?.[1]
      const eventListener = electron.on.mock.calls.find(([channel]) => channel === "adapter:tick")?.[1]
      expect(captureThrow(win.fireUnload)).toBe(removalCause)
      eventListener({ ports: [] }, { seq: 1 })
      grantListener({ ports: [{}] }, { nonce: "late" })
      releaseEvent()
      dispose()
      win.fireUnload()
      win.fireRetainedUnload()
      expect(received).toEqual([])
      expect(win.postMessage).not.toHaveBeenCalled()
      expect(electron.removeListener.mock.calls).toEqual([
        ["adapter:tick", eventListener],
        ["adapter:rpcPort:grant", grantListener]
      ])
      expect(win.removeEventListener).toHaveBeenCalledTimes(1)
      vi.unstubAllGlobals()
    }))

  it.effect("preserves bridge cleanup aggregate order through unload disposal", () =>
    Effect.sync(() => {
      const eventCause = new Error("event release failed")
      const removalCause = new Error("unload removal failed")
      const grantCause = new Error("grant release failed")
      electron.removeListener.mockImplementation((channel) => {
        if (channel === "adapter:tick") throw eventCause
        if (channel === "adapter:rpcPort:grant") throw grantCause
      })

      const directWindow = makeWindow({ removeError: removalCause })
      vi.stubGlobal("window", directWindow)
      const directDispose = exposeBridge(AdapterContract, "adapter", electronPreloadDeps())
      const directApi = electron.exposeInMainWorld.mock.calls[0]?.[1]
      directApi.tick(() => {})
      const directThrown = captureThrow(directDispose)
      expect(directThrown).toBeInstanceOf(AggregateError)
      if (!(directThrown instanceof AggregateError)) throw directThrown
      expect(directThrown.errors).toEqual([eventCause, removalCause, grantCause])

      electron.on.mockClear()
      electron.removeListener.mockClear()
      electron.exposeInMainWorld.mockClear()
      const unloadWindow = makeWindow({ removeError: removalCause })
      vi.stubGlobal("window", unloadWindow)
      exposeBridge(AdapterContract, "adapter", electronPreloadDeps())
      const unloadApi = electron.exposeInMainWorld.mock.calls[0]?.[1]
      unloadApi.tick(() => {})
      const unloadThrown = captureThrow(unloadWindow.fireUnload)
      expect(unloadThrown).toBeInstanceOf(AggregateError)
      if (!(unloadThrown instanceof AggregateError)) throw unloadThrown
      expect(unloadThrown.errors).toEqual(directThrown.errors)
      vi.unstubAllGlobals()
    }))
})
