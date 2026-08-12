import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, Schema, Stream } from "effect"
import React from "react"
import { Text } from "ink"
import { render } from "ink-testing-library"
import { describe, expect, vi } from "vitest"

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
      invoke: (channel: string, payload: unknown) => { electron.ipcRenderer.invokes.push([channel, payload]); return null },
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
import * as electronMain from "@expand/electron-ipc/main"
import * as electronPreload from "@expand/electron-ipc/preload"
import * as electronRenderer from "@expand/electron-ipc/renderer"
import * as inkInput from "@expand/ink-input"
import { initialUiState } from "@expand/tui/input/state"
import { route } from "@expand/tui/input/route"
import { uiReduce } from "@expand/tui/input/reduce"

const settled = (value: unknown): unknown => {
  const result = Object.create(null) as Record<string, unknown>
  result.then = (onfulfilled: unknown) => typeof onfulfilled === "function" ? Reflect.apply(onfulfilled, undefined, [value]) : undefined
  return result
}

type ElectronWindow = Parameters<typeof electronMain.bindElectronIpc>[2]["window"]

const contract = IpcContract.make("sample", {
  send: IpcChannel.send({ payload: Schema.String }),
  invoke: IpcChannel.invoke({ payload: Schema.Number, success: Schema.Number, error: Schema.String }),
  event: IpcChannel.event({ payload: Schema.Struct({ value: Schema.Number }) }),
  port: IpcChannel.portExchange()
})

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

const withRendererWindow = <A, E, R>(fixture: RendererWindowFixture, bridge: Record<string, unknown>, action: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
  const globalObject = globalThis as typeof globalThis & { window?: unknown }
  const previous = globalObject.window
  const windowWithBridge = fixture.window as RendererWindowFixture["window"] & { sample?: Record<string, unknown> }
  const previousBridge = windowWithBridge.sample
  const install = Effect.sync(() => {
    windowWithBridge.sample = bridge
    Object.defineProperty(globalObject, "window", { configurable: true, value: fixture.window })
  })
  const restore = Effect.sync(() => {
    if (previousBridge === undefined) delete windowWithBridge.sample
    else windowWithBridge.sample = previousBridge
    if (previous === undefined) delete globalObject.window
    else Object.defineProperty(globalObject, "window", { configurable: true, value: previous })
  })
  return install.pipe(Effect.flatMap(() => action), Effect.ensuring(restore))
}

const failedText = (exit: Exit.Exit<unknown, unknown>): string => {
  if (Exit.isSuccess(exit)) return ""
  return String(Cause.squash(exit.cause))
}

const provideNode = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, never> => effect.pipe(Effect.provide(NodeServices.layer)) as Effect.Effect<A, E, never>

describe("Electron public behavioral contract", () => {
  it.live("acquires a port with internally supplied browser crypto and no Crypto environment", () => provideNode(Effect.gen(function* () {
    const { makeElectronIpcClient } = electronRenderer
    const fixture = makeRendererWindow()
    const port = {} as MessagePort
    const requested: Array<string> = []
    const bridge = {
      port: (nonce: string) => {
        requested.push(nonce)
        fixture.fire({ data: { _tag: "IpcPortGrant", channel: "sample:port", nonce }, source: fixture.window, ports: [port] })
      }
    }
    yield* withRendererWindow(fixture, bridge, Effect.gen(function* () {
      const client = makeElectronIpcClient(contract, { timeoutMillis: 100 }) as Record<string, unknown>
      const acquired = yield* client.port as Effect.Effect<MessagePort, unknown, never>
      expect(acquired).toBe(port)
      expect(requested).toHaveLength(1)
    }))
  })))

  it.live("does not accept a public nonce override", () => provideNode(Effect.gen(function* () {
    const renderer = electronRenderer as Record<string, unknown>
    expect(renderer).not.toHaveProperty("browserCrypto")
    expect(renderer).not.toHaveProperty("Crypto")
    expect(Object.keys(renderer)).not.toContain("nonce")
  })))

  it.live("turns malformed event payloads into IpcTransportError failures", () => provideNode(Effect.gen(function* () {
    const { makeElectronIpcClient } = electronRenderer
    const fixture = makeRendererWindow()
    let listener: ((payload: unknown) => void) | undefined
    const subscribed = yield* Deferred.make<void>()
    const bridge = { event: (next: (payload: unknown) => void) => { listener = next; Deferred.doneUnsafe(subscribed, Effect.void); return () => { listener = undefined } } }
    yield* withRendererWindow(fixture, bridge, Effect.gen(function* () {
      const client = makeElectronIpcClient(contract) as Record<string, unknown>
      const fiber = yield* Effect.scoped(Stream.runCollect(client.event as Stream.Stream<unknown, unknown, never>)).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(subscribed)
      listener?.({ value: "not-a-number" })
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(failedText(exit)).toContain("IpcTransportError")
    }))
  })))

  it.live("rejects result envelopes whose success payload property is absent", () => provideNode(Effect.gen(function* () {
    const { makeElectronIpcClient } = electronRenderer
    const fixture = makeRendererWindow()
    yield* withRendererWindow(fixture, { invoke: () => settled({ _tag: "IpcSuccess" }) }, Effect.gen(function* () {
      const client = makeElectronIpcClient(contract) as Record<string, unknown>
      const exit = yield* (client.invoke as (value: number) => Effect.Effect<unknown, unknown, never>)(1).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(failedText(exit)).toContain("IpcTransportError")
    }))
  })))

  it.live("rejects result envelopes whose failure payload property is absent", () => provideNode(Effect.gen(function* () {
    const { makeElectronIpcClient } = electronRenderer
    const fixture = makeRendererWindow()
    yield* withRendererWindow(fixture, { invoke: () => settled({ _tag: "IpcFailure" }) }, Effect.gen(function* () {
      const client = makeElectronIpcClient(contract) as Record<string, unknown>
      const exit = yield* (client.invoke as (value: number) => Effect.Effect<unknown, unknown, never>)(1).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(failedText(exit)).toContain("IpcTransportError")
    }))
  })))

  it.live("rejects invalid and cross-shaped result envelopes", () => provideNode(Effect.gen(function* () {
    const { makeElectronIpcClient } = electronRenderer
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
      yield* withRendererWindow(fixture, { invoke: () => settled(envelope) }, Effect.gen(function* () {
        const client = makeElectronIpcClient(contract) as Record<string, unknown>
        const exit = yield* (client.invoke as (value: number) => Effect.Effect<unknown, unknown, never>)(1).pipe(Effect.exit)
        expect(Exit.isFailure(exit), JSON.stringify(envelope)).toBe(true)
        expect(failedText(exit), JSON.stringify(envelope)).toContain("IpcTransportError")
      }))
    }
  })))

  it.live("validates renderer timeout options before acquiring a client", () => provideNode(Effect.gen(function* () {
    const { makeElectronIpcClient } = electronRenderer
    const fixture = makeRendererWindow()
    yield* withRendererWindow(fixture, {}, Effect.sync(() => {
      for (const timeoutMillis of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => makeElectronIpcClient(contract, { timeoutMillis }), String(timeoutMillis)).toThrow()
      }
      expect(() => makeElectronIpcClient(contract, { timeoutMillis: 1 })).not.toThrow()
    }))
  })))

  it.live("measures the payload cap in UTF-8 bytes", () => provideNode(Effect.gen(function* () {
    const { bindElectronIpc } = electronMain
    const calls: Array<string> = []
    const mainFrame = { url: "https://app.example/", detached: false }
    const target = { webContents: { mainFrame, send: () => {} }, loadURL: () => undefined }
    yield* Effect.scoped(Effect.gen(function* () {
      const emitter = yield* bindElectronIpc(contract, {
        send: (value: string) => Effect.sync(() => { calls.push(value) }),
        invoke: () => Effect.succeed(0),
        port: () => Effect.void
      }, { window: target as unknown as ElectronWindow, rendererOrigin: "https://app.example", maxPayloadBytes: 2 })
      expect(emitter.event).toBeTypeOf("function")
      const event = { sender: target.webContents, senderFrame: target.webContents.mainFrame }
      electron.listeners.get("sample:send")?.(event, "é")
      electron.listeners.get("sample:send")?.(event, "😀")
      yield* Effect.sleep("10 millis")
    }))
    expect(calls).toEqual(["é"])
  })))

  it.live("admits only the configured webContents, live mainFrame, and trusted exact location", () => provideNode(Effect.gen(function* () {
    const { bindElectronIpc } = electronMain
    const mainFrame = { url: "https://app.example/", detached: false }
    const target = { webContents: { mainFrame, send: () => {} }, loadURL: () => undefined }
    const foreign = { mainFrame: target.webContents.mainFrame }
    const sameUrlOtherFrame = { url: target.webContents.mainFrame.url, detached: false }
    const calls: Array<string> = []
    electron.listeners.clear()
    yield* Effect.scoped(Effect.gen(function* () {
      const emitter = yield* bindElectronIpc(contract, {
        send: (value: string) => Effect.sync(() => { calls.push(value) }),
        invoke: () => Effect.succeed(0),
        port: () => Effect.void
      }, { window: target as unknown as ElectronWindow, rendererOrigin: "https://app.example", maxPayloadBytes: 20 })
      expect(emitter.event).toBeTypeOf("function")
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
    }))
    expect(calls).toEqual(["trusted"])

    const fileFrame = { url: "file:///app/index.html", detached: false }
    const fileTarget = { webContents: { mainFrame: fileFrame, send: () => {} }, loadURL: () => undefined }
    const fileCalls: Array<string> = []
    electron.listeners.clear()
    yield* Effect.scoped(Effect.gen(function* () {
      const emitter = yield* bindElectronIpc(contract, {
        send: (value: string) => Effect.sync(() => { fileCalls.push(value) }),
        invoke: () => Effect.succeed(0),
        port: () => Effect.void
      }, { window: fileTarget as unknown as ElectronWindow, rendererUrl: "file:///app/index.html", maxPayloadBytes: 20 })
      expect(emitter.event).toBeTypeOf("function")
      fileFrame.url = "file:///app/other.html"
      electron.listeners.get("sample:send")?.({ sender: fileTarget.webContents, senderFrame: fileFrame }, "wrong-file")
      fileFrame.url = "file:///app/index.html"
      electron.listeners.get("sample:send")?.({ sender: fileTarget.webContents, senderFrame: fileTarget.webContents.mainFrame }, "trusted-file")
      yield* Effect.sleep("10 millis")
    }))
    expect(fileCalls).toEqual(["trusted-file"])
  })))

  it.live("rejects invalid payload and broad fileProtocol options", () => provideNode(Effect.gen(function* () {
    const { bindElectronIpc } = electronMain
    const target = { webContents: { mainFrame: { url: "https://app.example/", detached: false }, send: () => {} }, loadURL: () => undefined }
    const bind = (options: Record<string, unknown>) => Effect.scoped(bindElectronIpc(contract, { send: () => Effect.void, invoke: () => Effect.succeed(0), port: () => Effect.void }, { window: target as unknown as ElectronWindow, ...options }))
    for (const maxPayloadBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      const exit = yield* bind({ rendererOrigin: "https://app.example", maxPayloadBytes }).pipe(Effect.exit)
      expect(Exit.isFailure(exit), String(maxPayloadBytes)).toBe(true)
    }
    for (const options of [
      {},
      { rendererOrigin: "https://app.example/path" },
      { rendererOrigin: "https://user:pass@app.example" },
      { rendererOrigin: "file://" },
      { rendererOrigin: "app.example" },
      { rendererOrigin: "https://app.example", rendererUrl: "https://app.example/" },
      { rendererUrl: "file://" }
    ]) {
      const exit = yield* bind(options).pipe(Effect.exit)
      expect(Exit.isFailure(exit), JSON.stringify(options)).toBe(true)
    }
    const fileTarget = { webContents: { mainFrame: { url: "file:///app/index.html", detached: false }, send: () => {} }, loadURL: () => undefined }
    const emitter = yield* Effect.scoped(bindElectronIpc(contract, { send: () => Effect.void, invoke: () => Effect.succeed(0), port: () => Effect.void }, { window: fileTarget as unknown as ElectronWindow, rendererUrl: "file:///app/index.html" }))
    expect(emitter.event).toBeTypeOf("function")
  })))

  it.live("derives the preload global from the contract prefix and blocks retained calls after disposal", () => provideNode(Effect.gen(function* () {
    const { exposeElectronBridge } = electronPreload
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
    const action = Effect.gen(function* () {
      exposeElectronBridge(contract)
      expect(electron.exposed[0]?.key).toBe("sample")
      const api = electron.exposed[0]?.api
      ;(api?.send as (value: string) => void)("before")
      ;(api?.invoke as (value: number) => unknown)(1)
      ;(api?.port as (value: string) => void)("before")
      lifecycle.get("unload")?.()
      try { ;(api?.send as (value: string) => void)("after") } catch {}
      yield* Effect.tryPromise({
        try: () => Reflect.apply(api?.invoke as Function, api, [2]),
        catch: () => undefined
      }).pipe(Effect.ignore)
      try { ;(api?.port as (value: string) => void)("after") } catch {}
    })
    yield* Effect.ensuring(action, Effect.sync(() => {
      if (previous === undefined) delete globalObject.window
      else Object.defineProperty(globalObject, "window", { configurable: true, value: previous })
    }))
    expect(electron.ipcRenderer.sends).toHaveLength(2)
    expect(electron.ipcRenderer.invokes).toHaveLength(1)
  })))
})

describe("Ink public behavioral contract", () => {
  it.live("preserves modifiers on special-key events as one event object", () => provideNode(Effect.gen(function* () {
    const { useGlobalKeyRouter } = inkInput
    const events: Array<Record<string, unknown>> = []
    const Probe = () => {
      useGlobalKeyRouter((event: Record<string, unknown>) => { events.push(event) })
      return React.createElement(Text, null, "probe")
    }
    const instance = render(React.createElement(Probe))
    yield* Effect.ensuring(Effect.sleep("20 millis").pipe(Effect.andThen(Effect.sync(() => {
      instance.stdin.write("\u001b[1;2A")
    })), Effect.andThen(Effect.sleep("20 millis"))), Effect.sync(() => { instance.unmount() }))
    expect(events).toEqual([expect.objectContaining({ key: "up", input: "", shift: true })])
  })))

  it.live("rejects duplicate keys within and across binding entries", () => provideNode(Effect.gen(function* () {
    const { defineBindings } = inkInput
    const binding = (keys: ReadonlyArray<string>, label = "action") => ({ keys, label, action: "action" })
    expect(() => defineBindings([binding(["j", "j"])] )).toThrow()
    expect(() => defineBindings([binding(["j"]), binding(["j"], "other")])).toThrow()
  })))

  it.live("rejects invalid binding keys and empty labels", () => provideNode(Effect.gen(function* () {
    const { defineBindings } = inkInput
    expect(() => defineBindings([{ keys: ["not-a-key"], label: "action", action: "action" }])).toThrow()
    expect(() => defineBindings([{ keys: ["j"], label: "", action: "action" }])).toThrow()
    expect(() => defineBindings([{ keys: ["j"], label: "   ", action: "action" }])).toThrow()
  })))

  it.live("owns resolution and hints on the returned binding table", () => provideNode(Effect.gen(function* () {
    const { defineBindings } = inkInput
    const table = defineBindings([
      { keys: ["j"], label: "next", action: "next" },
      { keys: ["ctrl+j"], label: "special", action: "special" }
    ]) as Record<string, unknown>
    expect(table.resolve).toBeTypeOf("function")
    expect(table.hints).toBeTypeOf("function")
    expect((table.resolve as (event: unknown) => unknown)({ key: "j", input: "j", shift: false, ctrl: false, meta: false })).toBe("next")
    expect((table.resolve as (event: unknown) => unknown)({ key: "j", input: "j", shift: false, ctrl: true, meta: false })).toBe("special")
    expect((table.hints as () => unknown)()).toEqual([{ key: "j", label: "next" }, { key: "ctrl+j", label: "special" }])
  })))

  it.live("routes a focused create KeyEvent to the app editor without list actions or effects", () => provideNode(Effect.gen(function* () {
    const event = { key: "d", input: "d", ctrl: false, meta: false, shift: false }
    const projects = [{ id: "project", name: "project", directory: null, description: null, tags: [], archived: false, createdAt: "", updatedAt: "" }] as unknown as Parameters<typeof route>[1]
    const ui = { ...initialUiState, focus: "create" as const } as typeof initialUiState
    const action = route(ui, projects, event)
    if (action === null) throw new Error("expected edit action")
    const reduced = uiReduce(ui, action)
    expect(reduced.ui.create.value).toBe("d")
    expect(reduced.effects).toEqual([])
  })))

  it.live("routes a focused overlay KeyEvent to the app editor without list actions or effects", () => provideNode(Effect.gen(function* () {
    const event = { key: "x", input: "x", ctrl: false, meta: false, shift: false }
    const projects = [{ id: "project", name: "project", directory: null, description: null, tags: [], archived: false, createdAt: "", updatedAt: "" }] as unknown as Parameters<typeof route>[1]
    const ui = {
      ...initialUiState,
      overlay: { kind: "rename", projectId: "project", field: { value: "old", cursor: 3 } } as const
    } as typeof initialUiState
    const action = route(ui, projects, event)
    if (action === null) throw new Error("expected edit action")
    const reduced = uiReduce(ui, action)
    if (reduced.ui.overlay?.kind !== "rename") throw new Error("expected rename overlay")
    expect(reduced.ui.overlay.field.value).toBe("oldx")
    expect(reduced.effects).toEqual([])
  })))
})
