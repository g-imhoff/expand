import { Cause, Effect, Exit, Schema, Stream } from "effect"
import { describe, expect, it, vi } from "vitest"
import React from "react"
import { Text } from "ink"
import { render } from "ink-testing-library"

const electron = vi.hoisted(() => {
  const listeners = new Map<string, (event: unknown, payload: unknown) => void>()
  return {
    listeners,
    ipcMain: {
      on: (channel: string, listener: (event: unknown, payload: unknown) => void) => { listeners.set(channel, listener); return () => { listeners.delete(channel) } },
      off: (channel: string) => { listeners.delete(channel) },
      handle: () => () => {},
      removeHandler: () => {}
    },
    exposed: new Array<{ key: string; api: Record<string, unknown> }>(),
    ipcRenderer: {
      sends: new Array<readonly [string, unknown]>(),
      invokes: new Array<readonly [string, unknown]>(),
      listeners: new Map<string, (...args: Array<unknown>) => unknown>(),
      send: (channel: string, payload: unknown) => { electron.ipcRenderer.sends.push([channel, payload]) },
      invoke: (channel: string, payload: unknown) => { electron.ipcRenderer.invokes.push([channel, payload]); return Promise.resolve(null) },
      on: (channel: string, listener: (...args: Array<unknown>) => unknown) => { electron.ipcRenderer.listeners.set(channel, listener) },
      removeListener: (channel: string) => { electron.ipcRenderer.listeners.delete(channel) }
    },
    contextBridge: {
      exposeInMainWorld: (key: string, api: Record<string, unknown>) => { electron.exposed.push({ key, api }) }
    }
  }
})

vi.mock("electron", () => ({ ipcMain: electron.ipcMain, ipcRenderer: electron.ipcRenderer, contextBridge: electron.contextBridge }))
import { IpcChannel, IpcContract } from "@expand/electron-ipc/contract"

const contract = IpcContract.make("sample", {
  send: IpcChannel.send({ payload: Schema.String }),
  invoke: IpcChannel.invoke({ payload: Schema.Number, success: Schema.Number, error: Schema.String }),
  event: IpcChannel.event({ payload: Schema.Struct({ value: Schema.Number }) }),
  port: IpcChannel.portExchange()
})

const load = async <T>(specifier: string): Promise<T> => import(specifier) as Promise<T>

interface RendererWindowFixture {
  readonly window: {
    readonly addEventListener: (type: "message", listener: (event: MessageEventFixture) => void) => void
    readonly removeEventListener: (type: "message", listener: (event: MessageEventFixture) => void) => void
  }
  readonly fire: (event: MessageEventFixture) => void
}

interface MessageEventFixture {
  readonly data: unknown
  readonly source: unknown
  readonly ports: ReadonlyArray<MessagePort>
}

const makeRendererWindow = (): RendererWindowFixture => {
  const listeners = new Set<(event: MessageEventFixture) => void>()
  const window = {
    addEventListener: (_type: "message", listener: (event: MessageEventFixture) => void) => listeners.add(listener),
    removeEventListener: (_type: "message", listener: (event: MessageEventFixture) => void) => listeners.delete(listener)
  }
  return { window, fire: (event) => { for (const listener of listeners) listener(event) } }
}

const withRendererWindow = async <A>(fixture: RendererWindowFixture, bridge: Record<string, unknown>, action: () => Promise<A>): Promise<A> => {
  const globalObject = globalThis as typeof globalThis & { window?: unknown }
  const previous = globalObject.window
  const windowWithBridge = fixture.window as RendererWindowFixture["window"] & { sample?: Record<string, unknown> }
  const previousBridge = windowWithBridge.sample
  windowWithBridge.sample = bridge
  Object.defineProperty(globalObject, "window", { configurable: true, value: fixture.window })
  try {
    return await action()
  } finally {
    if (previousBridge === undefined) delete windowWithBridge.sample
    else windowWithBridge.sample = previousBridge
    if (previous === undefined) delete globalObject.window
    else Object.defineProperty(globalObject, "window", { configurable: true, value: previous })
  }
}

const failedText = (exit: Exit.Exit<unknown, unknown>): string => {
  if (Exit.isSuccess(exit)) return ""
  return String(Cause.squash(exit.cause))
}

describe("Electron public behavioral contract", () => {
  it("acquires a port with internally supplied browser crypto and no Crypto environment", async () => {
    const { makeElectronIpcClient } = await load<{ makeElectronIpcClient: Function }>("@expand/electron-ipc/renderer")
    const fixture = makeRendererWindow()
    const port = {} as MessagePort
    const requested: Array<string> = []
    const bridge = {
      port: (nonce: string) => {
        requested.push(nonce)
        fixture.fire({ data: { _tag: "IpcPortGrant", channel: "sample:port", nonce }, source: fixture.window, ports: [port] })
      }
    }
    await withRendererWindow(fixture, bridge, async () => {
      const client = makeElectronIpcClient(contract, { timeoutMillis: 100 }) as Record<string, unknown>
      const acquired = await Effect.runPromise(client.port as Effect.Effect<MessagePort, unknown, never>)
      expect(acquired).toBe(port)
      expect(requested).toHaveLength(1)
    })
  })

  it("does not accept a public nonce override", async () => {
    const renderer = await load<Record<string, unknown>>("@expand/electron-ipc/renderer")
    expect(renderer).not.toHaveProperty("browserCrypto")
    expect(renderer).not.toHaveProperty("Crypto")
    expect(Object.keys(renderer)).not.toContain("nonce")
  })

  it("turns malformed event payloads into IpcTransportError failures", async () => {
    const { makeElectronIpcClient } = await load<{ makeElectronIpcClient: Function }>("@expand/electron-ipc/renderer")
    const fixture = makeRendererWindow()
    let listener: ((payload: unknown) => void) | undefined
    const bridge = { event: (next: (payload: unknown) => void) => { listener = next; return () => { listener = undefined } } }
    await withRendererWindow(fixture, bridge, async () => {
      const client = makeElectronIpcClient(contract) as Record<string, unknown>
      const fiber = Effect.runPromiseExit(
        Stream.runCollect(client.event as Stream.Stream<unknown, unknown, never>).pipe(Effect.timeout("100 millis"))
      )
      await Promise.resolve()
      listener?.({ value: "not-a-number" })
      const exit = await fiber
      expect(Exit.isFailure(exit)).toBe(true)
      expect(failedText(exit)).toContain("IpcTransportError")
    })
  })

  it("rejects result envelopes whose success payload property is absent", async () => {
    const { makeElectronIpcClient } = await load<{ makeElectronIpcClient: Function }>("@expand/electron-ipc/renderer")
    const fixture = makeRendererWindow()
    await withRendererWindow(fixture, { invoke: () => Promise.resolve({ _tag: "IpcSuccess" }) }, async () => {
      const client = makeElectronIpcClient(contract) as Record<string, unknown>
      const exit = await Effect.runPromiseExit((client.invoke as (value: number) => Effect.Effect<unknown, unknown, never>)(1))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(failedText(exit)).toContain("IpcTransportError")
    })
  })

  it("rejects result envelopes whose failure payload property is absent", async () => {
    const { makeElectronIpcClient } = await load<{ makeElectronIpcClient: Function }>("@expand/electron-ipc/renderer")
    const fixture = makeRendererWindow()
    await withRendererWindow(fixture, { invoke: () => Promise.resolve({ _tag: "IpcFailure" }) }, async () => {
      const client = makeElectronIpcClient(contract) as Record<string, unknown>
      const exit = await Effect.runPromiseExit((client.invoke as (value: number) => Effect.Effect<unknown, unknown, never>)(1))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(failedText(exit)).toContain("IpcTransportError")
    })
  })

  it("rejects invalid and cross-shaped result envelopes", async () => {
    const { makeElectronIpcClient } = await load<{ makeElectronIpcClient: Function }>("@expand/electron-ipc/renderer")
    const fixture = makeRendererWindow()
    const inheritedSuccess = Object.create({ value: 1 }) as Record<string, unknown>
    inheritedSuccess._tag = "IpcSuccess"
    const inheritedFailure = Object.create({ error: "failure" }) as Record<string, unknown>
    inheritedFailure._tag = "IpcFailure"
    const envelopes: ReadonlyArray<unknown> = [
      { _tag: "Other", value: 1 },
      { _tag: "IpcSuccess", value: 1, error: "opposite" },
      { _tag: "IpcSuccess", error: "opposite" },
      { _tag: "IpcSuccess", value: 1, arbitrary: true },
      inheritedSuccess,
      { _tag: "IpcFailure", error: "failure", value: 1 },
      { _tag: "IpcFailure", value: 1 },
      { _tag: "IpcFailure", error: "failure", arbitrary: true },
      inheritedFailure,
      { _tag: "IpcDefect" },
      { _tag: "IpcDefect", message: 1 },
      { _tag: "IpcDefect", message: "defect", arbitrary: true },
      { _tag: "IpcDefect", message: "defect", value: 1 },
      { _tag: "IpcDefect", message: "defect", error: "failure" }
    ]
    for (const envelope of envelopes) {
      await withRendererWindow(fixture, { invoke: () => Promise.resolve(envelope) }, async () => {
        const client = makeElectronIpcClient(contract) as Record<string, unknown>
        const exit = await Effect.runPromiseExit((client.invoke as (value: number) => Effect.Effect<unknown, unknown, never>)(1))
        expect(Exit.isFailure(exit), JSON.stringify(envelope)).toBe(true)
        expect(failedText(exit), JSON.stringify(envelope)).toContain("IpcTransportError")
      })
    }
  })

  it("validates renderer timeout options before acquiring a client", async () => {
    const { makeElectronIpcClient } = await load<{ makeElectronIpcClient: Function }>("@expand/electron-ipc/renderer")
    const fixture = makeRendererWindow()
    await withRendererWindow(fixture, {}, async () => {
      for (const timeoutMillis of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5]) {
        expect(() => makeElectronIpcClient(contract, { timeoutMillis }), String(timeoutMillis)).toThrow()
      }
      expect(() => makeElectronIpcClient(contract, { timeoutMillis: 1 })).not.toThrow()
    })
  })

  it("measures the payload cap in UTF-8 bytes", async () => {
    const { bindElectronIpc } = await load<{ bindElectronIpc: Function }>("@expand/electron-ipc/main")
    const calls: Array<string> = []
    const mainFrame = { url: "https://app.example/", detached: false }
    const target = { webContents: { mainFrame, send: () => {} }, loadURL: async () => {} }
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      yield* bindElectronIpc(contract, {
        send: (value: string) => Effect.sync(() => { calls.push(value) }),
        invoke: () => Effect.succeed(0),
        port: () => Effect.void
      }, { window: target, rendererOrigin: "https://app.example", maxPayloadBytes: 2 }) as Effect.Effect<unknown, unknown, never>
      const event = { sender: target.webContents, senderFrame: target.webContents.mainFrame }
      electron.listeners.get("sample:send")?.(event, "é")
      electron.listeners.get("sample:send")?.(event, "😀")
      yield* Effect.sleep("10 millis")
    })))
    expect(calls).toEqual(["é"])
  })

  it("admits only the configured webContents, live mainFrame, and trusted exact location", async () => {
    const { bindElectronIpc } = await load<{ bindElectronIpc: Function }>("@expand/electron-ipc/main")
    const mainFrame = { url: "https://app.example/", detached: false }
    const target = { webContents: { mainFrame, send: () => {} }, loadURL: async () => {} }
    const foreign = { mainFrame: target.webContents.mainFrame }
    const sameUrlOtherFrame = { url: target.webContents.mainFrame.url, detached: false }
    const calls: Array<string> = []
    electron.listeners.clear()
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      yield* bindElectronIpc(contract, {
        send: (value: string) => Effect.sync(() => { calls.push(value) }),
        invoke: () => Effect.succeed(0),
        port: () => Effect.void
      }, { window: target, rendererOrigin: "https://app.example", maxPayloadBytes: 20 }) as Effect.Effect<unknown, unknown, never>
      const listener = electron.listeners.get("sample:send")
      listener?.({ sender: foreign, senderFrame: target.webContents.mainFrame }, "foreign")
      listener?.({ sender: target.webContents, senderFrame: sameUrlOtherFrame }, "other-frame")
      mainFrame.detached = true
      listener?.({ sender: target.webContents, senderFrame: mainFrame }, "detached")
      mainFrame.detached = false
      listener?.({ sender: target.webContents, senderFrame: null }, "null-frame")
      mainFrame.url = "https://other.example/"
      listener?.({ sender: target.webContents, senderFrame: mainFrame }, "wrong-origin")
      mainFrame.url = "https://app.example/"
      listener?.({ sender: target.webContents, senderFrame: target.webContents.mainFrame }, "trusted")
      yield* Effect.sleep("10 millis")
    })))
    expect(calls).toEqual(["trusted"])

    const fileFrame = { url: "file:///app/index.html", detached: false }
    const fileTarget = { webContents: { mainFrame: fileFrame, send: () => {} }, loadURL: async () => {} }
    const fileCalls: Array<string> = []
    electron.listeners.clear()
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      yield* bindElectronIpc(contract, {
        send: (value: string) => Effect.sync(() => { fileCalls.push(value) }),
        invoke: () => Effect.succeed(0),
        port: () => Effect.void
      }, { window: fileTarget, rendererUrl: "file:///app/index.html", maxPayloadBytes: 20 }) as Effect.Effect<unknown, unknown, never>
      fileFrame.url = "file:///app/other.html"
      electron.listeners.get("sample:send")?.({ sender: fileTarget.webContents, senderFrame: fileFrame }, "wrong-file")
      fileFrame.url = "file:///app/index.html"
      electron.listeners.get("sample:send")?.({ sender: fileTarget.webContents, senderFrame: fileTarget.webContents.mainFrame }, "trusted-file")
      yield* Effect.sleep("10 millis")
    })))
    expect(fileCalls).toEqual(["trusted-file"])
  })

  it("rejects invalid payload and broad fileProtocol options", async () => {
    const { bindElectronIpc } = await load<{ bindElectronIpc: Function }>("@expand/electron-ipc/main")
    const target = { webContents: { mainFrame: { url: "https://app.example/", detached: false }, send: () => {} }, loadURL: async () => {} }
    const bind = (options: Record<string, unknown>) => Effect.runPromise(Effect.scoped(bindElectronIpc(contract, { send: () => Effect.void, invoke: () => Effect.succeed(0), port: () => Effect.void }, { window: target, ...options })))
    for (const maxPayloadBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(bind({ rendererOrigin: "https://app.example", maxPayloadBytes }), String(maxPayloadBytes)).rejects.toThrow()
    }
    await expect(bind({})).rejects.toThrow()
    await expect(bind({ rendererOrigin: "https://app.example/path" })).rejects.toThrow()
    await expect(bind({ rendererOrigin: "https://user:pass@app.example" })).rejects.toThrow()
    await expect(bind({ rendererOrigin: "file://" })).rejects.toThrow()
    await expect(bind({ rendererOrigin: "app.example" })).rejects.toThrow()
    await expect(bind({ rendererOrigin: "https://app.example", rendererUrl: "https://app.example/" })).rejects.toThrow()
    const fileTarget = { webContents: { mainFrame: { url: "file:///app/index.html", detached: false }, send: () => {} }, loadURL: async () => {} }
    await expect(Effect.runPromise(Effect.scoped(bindElectronIpc(contract, { send: () => Effect.void, invoke: () => Effect.succeed(0), port: () => Effect.void }, { window: fileTarget, rendererUrl: "file:///app/index.html" })))).resolves.toBeUndefined()
    await expect(bind({ rendererUrl: "file://" })).rejects.toThrow()
  })

  it("derives the preload global from the contract prefix and blocks retained calls after disposal", async () => {
    const { exposeElectronBridge } = await load<{ exposeElectronBridge: Function }>("@expand/electron-ipc/preload")
    const globalObject = globalThis as typeof globalThis & { window?: unknown }
    const previous = globalObject.window
    const lifecycle = new Map<string, () => void>()
    Object.defineProperty(globalObject, "window", { configurable: true, value: {
      location: { origin: "https://app.example" },
      addEventListener: (type: string, listener: () => void) => lifecycle.set(type, listener),
      removeEventListener: (type: string) => lifecycle.delete(type),
      postMessage: () => {}
    } })
    electron.exposed.length = 0
    electron.ipcRenderer.sends.length = 0
    electron.ipcRenderer.invokes.length = 0
    try {
      exposeElectronBridge(contract)
      expect(electron.exposed[0]?.key).toBe("sample")
      const api = electron.exposed[0]?.api
      ;(api?.send as (value: string) => void)("before")
      await (api?.invoke as (value: number) => Promise<unknown>)(1)
      ;(api?.port as (value: string) => void)("before")
      lifecycle.get("unload")?.()
      try { ;(api?.send as (value: string) => void)("after") } catch {}
      try { await (api?.invoke as (value: number) => Promise<unknown>)(2) } catch {}
      try { ;(api?.port as (value: string) => void)("after") } catch {}
      expect(electron.ipcRenderer.sends).toHaveLength(2)
      expect(electron.ipcRenderer.invokes).toHaveLength(1)
    } finally {
      if (previous === undefined) delete globalObject.window
      else Object.defineProperty(globalObject, "window", { configurable: true, value: previous })
    }
  })
})

describe("Ink public behavioral contract", () => {
  it("preserves modifiers on special-key events as one event object", async () => {
    const { useGlobalKeyRouter } = await load<{ useGlobalKeyRouter: Function }>("@expand/ink-input")
    const events: Array<Record<string, unknown>> = []
    const Probe = () => {
      useGlobalKeyRouter((event: Record<string, unknown>) => { events.push(event) })
      return React.createElement(Text, null, "probe")
    }
    const instance = render(React.createElement(Probe))
    try {
      await new Promise((resolve) => setTimeout(resolve, 20))
      instance.stdin.write("\u001b[1;2A")
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(events).toEqual([expect.objectContaining({ key: "up", input: "", shift: true })])
    } finally {
      instance.unmount()
    }
  })

  it("rejects duplicate keys within and across binding entries", async () => {
    const { defineBindings } = await load<{ defineBindings: Function }>("@expand/ink-input")
    const binding = (keys: ReadonlyArray<string>, label = "action") => ({ keys, label, action: "action" })
    expect(() => defineBindings([binding(["j", "j"])] )).toThrow()
    expect(() => defineBindings([binding(["j"]), binding(["j"], "other")])).toThrow()
  })

  it("rejects invalid binding keys and empty labels", async () => {
    const { defineBindings } = await load<{ defineBindings: Function }>("@expand/ink-input")
    expect(() => defineBindings([{ keys: ["not-a-key"], label: "action", action: "action" }])).toThrow()
    expect(() => defineBindings([{ keys: ["j"], label: "", action: "action" }])).toThrow()
    expect(() => defineBindings([{ keys: ["j"], label: "   ", action: "action" }])).toThrow()
  })

  it("owns resolution and hints on the returned binding table", async () => {
    const { defineBindings } = await load<{ defineBindings: Function }>("@expand/ink-input")
    const table = defineBindings([
      { keys: ["j"], label: "next", action: "next" },
      { keys: ["ctrl+j"], label: "special", action: "special" }
    ]) as Record<string, unknown>
    expect(table.resolve).toBeTypeOf("function")
    expect(table.hints).toBeTypeOf("function")
    expect((table.resolve as (event: unknown) => unknown)({ key: "j", input: "j", shift: false, ctrl: false, meta: false })).toBe("next")
    expect((table.resolve as (event: unknown) => unknown)({ key: "j", input: "j", shift: false, ctrl: true, meta: false })).toBe("special")
    expect((table.hints as () => unknown)()).toEqual([{ key: "j", label: "next" }, { key: "ctrl+j", label: "special" }])
  })

  it("routes a focused create KeyEvent to the app editor without list actions or effects", async () => {
    const { initialUiState } = await load<{ initialUiState: Record<string, unknown> }>("@expand/tui/input/state")
    const { route } = await load<{ route: Function }>("@expand/tui/input/route")
    const { uiReduce } = await load<{ uiReduce: Function }>("@expand/tui/input/reduce")
    const event = { key: "d", input: "d", ctrl: false, meta: false, shift: false }
    const projects = [{ id: "project", name: "project", description: null, tags: [], archived: false }]
    const ui = { ...initialUiState, focus: "create" }
    const action = route(ui, projects, event)
    expect(action).toBeDefined()
    const reduced = uiReduce(ui, action)
    expect(reduced.ui.create.value).toBe("d")
    expect(reduced.effects).toEqual([])
  })

  it("routes a focused overlay KeyEvent to the app editor without list actions or effects", async () => {
    const { initialUiState } = await load<{ initialUiState: Record<string, unknown> }>("@expand/tui/input/state")
    const { route } = await load<{ route: Function }>("@expand/tui/input/route")
    const { uiReduce } = await load<{ uiReduce: Function }>("@expand/tui/input/reduce")
    const event = { key: "x", input: "x", ctrl: false, meta: false, shift: false }
    const projects = [{ id: "project", name: "project", description: null, tags: [], archived: false }]
    const ui = {
      ...initialUiState,
      overlay: { kind: "rename", projectId: "project", field: { value: "old" } }
    }
    const action = route(ui, projects, event)
    expect(action).toBeDefined()
    const reduced = uiReduce(ui, action)
    expect(reduced.ui.overlay.field.value).toBe("oldx")
    expect(reduced.effects).toEqual([])
  })
})
