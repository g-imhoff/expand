import { Effect, Schema } from "effect"
import { it } from "@effect/vitest"
import { describe, expect, beforeEach, vi } from "vitest"
import { IpcChannel, IpcContract } from "../contract"

type IpcListener = (event: { readonly ports: ReadonlyArray<MessagePort> }, payload: unknown) => void
type WindowListener = () => void

const electron = vi.hoisted(() => {
  const listeners = new Map<string, Set<IpcListener>>()
  const exposed = new Array<{ readonly key: string; readonly api: Record<string, unknown> }>()
  const ipcRenderer = {
    sends: new Array<readonly [string, unknown]>(),
    invokes: new Array<readonly [string, unknown]>(),
    on: vi.fn((channel: string, listener: IpcListener) => {
      const channelListeners = listeners.get(channel) ?? new Set<IpcListener>()
      channelListeners.add(listener)
      listeners.set(channel, channelListeners)
    }),
    removeListener: vi.fn((channel: string, listener: IpcListener) => {
      listeners.get(channel)?.delete(listener)
      if (listeners.get(channel)?.size === 0) listeners.delete(channel)
    }),
    send: vi.fn((channel: string, payload: unknown) => { ipcRenderer.sends.push([channel, payload]) }),
    invoke: vi.fn((channel: string, payload: unknown) => {
      ipcRenderer.invokes.push([channel, payload])
      return Promise.resolve({ ok: true })
    }),
    emit: (channel: string, event: { readonly ports: ReadonlyArray<MessagePort> }, payload: unknown) => {
      for (const listener of electron.listeners.get(channel) ?? []) listener(event, payload)
    }
  }
  const contextBridge = {
    exposeInMainWorld: vi.fn((key: string, api: Record<string, unknown>) => { exposed.push({ key, api }) })
  }
  return { listeners, exposed, ipcRenderer, contextBridge }
})

vi.mock("electron", () => ({ ipcRenderer: electron.ipcRenderer, contextBridge: electron.contextBridge }))
const { exposeElectronBridge } = await import("../preload")

const contract = IpcContract.make("pre", {
  send: IpcChannel.send({ payload: Schema.String }),
  invoke: IpcChannel.invoke({ payload: Schema.String, success: Schema.String, error: Schema.String }),
  event: IpcChannel.event({ payload: Schema.String }),
  port: IpcChannel.portExchange()
})

const windowListeners = new Map<string, Set<WindowListener>>()
const windowMock = {
  location: { origin: "https://app.example" },
  addEventListener: vi.fn((type: string, listener: WindowListener) => {
    const typeListeners = windowListeners.get(type) ?? new Set<WindowListener>()
    typeListeners.add(listener)
    windowListeners.set(type, typeListeners)
  }),
  removeEventListener: vi.fn((type: string, listener: WindowListener) => {
    windowListeners.get(type)?.delete(listener)
    if (windowListeners.get(type)?.size === 0) windowListeners.delete(type)
  }),
  postMessage: vi.fn()
}
Object.defineProperty(globalThis, "window", { configurable: true, value: windowMock })

const apiFunction = <A extends (...args: never[]) => unknown>(api: Record<string, unknown>, key: string): A => api[key] as A
const first = <A>(values: ReadonlySet<A>): A => {
  const value = [...values][0]
  if (value === undefined) throw new Error("expected a registered callback")
  return value
}
const exposedApi = (): Record<string, unknown> => electron.exposed.at(-1)?.api ?? (() => { throw new Error("bridge was not exposed") })()
const fireUnload = (): void => { for (const listener of windowListeners.get("unload") ?? []) listener() }

beforeEach(() => {
  electron.listeners.clear()
  electron.exposed.length = 0
  electron.ipcRenderer.sends.length = 0
  electron.ipcRenderer.invokes.length = 0
  electron.ipcRenderer.on.mockReset()
  electron.ipcRenderer.on.mockImplementation((channel: string, listener: IpcListener) => {
    const channelListeners = electron.listeners.get(channel) ?? new Set<IpcListener>()
    channelListeners.add(listener)
    electron.listeners.set(channel, channelListeners)
  })
  electron.ipcRenderer.removeListener.mockReset()
  electron.ipcRenderer.removeListener.mockImplementation((channel: string, listener: IpcListener) => {
    electron.listeners.get(channel)?.delete(listener)
    if (electron.listeners.get(channel)?.size === 0) electron.listeners.delete(channel)
  })
  electron.ipcRenderer.send.mockClear()
  electron.ipcRenderer.invoke.mockClear()
  electron.contextBridge.exposeInMainWorld.mockReset()
  electron.contextBridge.exposeInMainWorld.mockImplementation((key: string, api: Record<string, unknown>) => { electron.exposed.push({ key, api }) })
  windowListeners.clear()
  windowMock.addEventListener.mockClear()
  windowMock.removeEventListener.mockClear()
  windowMock.postMessage.mockClear()
})

describe("preload Electron IPC facade", () => {
  it.effect("derives the global from the prefix and routes send, invoke, and port calls", () => Effect.gen(function* () {
    exposeElectronBridge(contract)
    const api = exposedApi()
    apiFunction<(payload: string) => void>(api, "send")("payload")
    yield* Effect.promise(() => apiFunction<(payload: string) => Promise<unknown>>(api, "invoke")("request"))
    apiFunction<(nonce: string) => void>(api, "port")("nonce-1")
    expect(electron.contextBridge.exposeInMainWorld).toHaveBeenCalledWith("pre", expect.any(Object))
    expect(electron.ipcRenderer.sends).toEqual([["pre:send", "payload"], ["pre:port:request", { nonce: "nonce-1" }]])
    expect(electron.ipcRenderer.invokes).toEqual([["pre:invoke", "request"]])
  }))

  it("delivers event payloads and removes an exact subscription idempotently", () => {
    exposeElectronBridge(contract)
    const received: Array<unknown> = []
    const dispose = apiFunction<(listener: (payload: unknown) => void) => () => void>(exposedApi(), "event")((payload) => { received.push(payload) })
    const wrapped = first(electron.listeners.get("pre:event") ?? new Set<IpcListener>())
    wrapped({ ports: [] }, "before")
    dispose()
    dispose()
    wrapped?.({ ports: [] }, "after")
    expect(received).toEqual(["before"])
    expect(electron.ipcRenderer.removeListener).toHaveBeenCalledTimes(1)
    expect(electron.ipcRenderer.removeListener).toHaveBeenCalledWith("pre:event", wrapped)
  })

  it("relays a grant with its exact nonce and transferred ports", () => {
    exposeElectronBridge(contract)
    const port = {} as MessagePort
    const event = { ports: [port] }
    const accessor = vi.fn(() => "nonce-2")
    const inherited = Object.create({ nonce: "nonce-2" }) as Record<string, unknown>
    const extra = { nonce: "nonce-2", extra: true }
    const getter = {}
    Object.defineProperty(getter, "nonce", { enumerable: true, get: accessor })
    electron.ipcRenderer.emit("pre:port:grant", event, inherited)
    electron.ipcRenderer.emit("pre:port:grant", event, extra)
    electron.ipcRenderer.emit("pre:port:grant", event, getter)
    expect(windowMock.postMessage).not.toHaveBeenCalled()
    expect(accessor).not.toHaveBeenCalled()
    electron.ipcRenderer.emit("pre:port:grant", event, { nonce: "nonce-2" })
    expect(windowMock.postMessage).toHaveBeenCalledWith({ _tag: "IpcPortGrant", channel: "pre:port", nonce: "nonce-2" }, "https://app.example", event.ports)
  })

  it.effect("blocks retained send, port, invoke, and event callbacks after unload", () => Effect.gen(function* () {
    exposeElectronBridge(contract)
    const api = exposedApi()
    const received: Array<unknown> = []
    apiFunction<(listener: (payload: unknown) => void) => () => void>(api, "event")((payload) => { received.push(payload) })
    const retainedEvent = [...(electron.listeners.get("pre:event") ?? [])][0]
    apiFunction<(payload: string) => void>(api, "send")("before")
    yield* Effect.promise(() => apiFunction<(payload: string) => Promise<unknown>>(api, "invoke")("before"))
    apiFunction<(nonce: string) => void>(api, "port")("before")
    const sendsBefore = electron.ipcRenderer.send.mock.calls.length
    const invokeBefore = electron.ipcRenderer.invoke.mock.calls.length
    fireUnload()
    apiFunction<(payload: string) => void>(api, "send")("after")
    apiFunction<(nonce: string) => void>(api, "port")("after")
    yield* Effect.promise(() => expect(apiFunction<(payload: string) => Promise<unknown>>(api, "invoke")("after")).rejects.toThrow("bridge unloaded"))
    retainedEvent?.({ ports: [] }, "after")
    expect(electron.ipcRenderer.send.mock.calls.length).toBe(sendsBefore)
    expect(electron.ipcRenderer.invoke.mock.calls.length).toBe(invokeBefore)
    expect(received).toEqual([])
    expect(electron.listeners.size).toBe(0)
  }))

  it("disposes registrations made before an acquisition failure", () => {
    const acquisitionError = new Error("port listener failed")
    electron.ipcRenderer.on.mockImplementation((channel: string, listener: IpcListener) => {
      if (channel === "pre:port:grant") throw acquisitionError
      const channelListeners = electron.listeners.get(channel) ?? new Set<IpcListener>()
      channelListeners.add(listener)
      electron.listeners.set(channel, channelListeners)
    })
    expect(() => exposeElectronBridge(contract)).toThrow(acquisitionError)
    expect(electron.ipcRenderer.removeListener).toHaveBeenCalledWith("pre:port:grant", expect.any(Function))
    expect(electron.listeners.size).toBe(0)
    expect(electron.exposed).toHaveLength(0)
  })

  it("attempts every disposer and preserves acquisition and cleanup failures", () => {
    const twoPorts = IpcContract.make("cleanup", {
      first: IpcChannel.portExchange(),
      second: IpcChannel.portExchange()
    })
    const acquisitionError = new Error("expose failed")
    const cleanupErrors = [new Error("first cleanup"), new Error("second cleanup"), new Error("unload cleanup")]
    electron.contextBridge.exposeInMainWorld.mockImplementation(() => { throw acquisitionError })
    electron.ipcRenderer.removeListener.mockImplementationOnce(() => { throw cleanupErrors[0] })
    electron.ipcRenderer.removeListener.mockImplementationOnce(() => { throw cleanupErrors[1] })
    windowMock.removeEventListener.mockImplementationOnce(() => { throw cleanupErrors[2] })
    let thrown: unknown
    try { exposeElectronBridge(twoPorts) } catch (error) { thrown = error }
    expect(thrown).toBeInstanceOf(AggregateError)
    const aggregate = thrown as AggregateError
    expect(aggregate.errors).toEqual([acquisitionError, ...cleanupErrors])
    expect(electron.ipcRenderer.removeListener).toHaveBeenCalledTimes(2)
    expect(windowMock.removeEventListener).toHaveBeenCalledTimes(1)
  })
})
