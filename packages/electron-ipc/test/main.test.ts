import { Cause, Context, Effect, Exit, Schema } from "effect"
import { TestClock } from "effect/testing"
import type { BrowserWindow, MessagePortMain } from "electron"
import { it } from "@effect/vitest"
import { describe, expect, expectTypeOf, beforeEach, vi } from "vitest"
import { IpcChannel, IpcContract, type IpcEmitterOf, type IpcHandlersOf } from "../contract"

type MainListener = (event: unknown, payload: unknown) => void
type MainHandler = (event: unknown, payload: unknown) => Promise<unknown>

const electron = vi.hoisted(() => {
  const listeners = new Map<string, Set<MainListener>>()
  const handlers = new Map<string, MainHandler>()
  const ipcMain = {
    on: vi.fn((channel: string, listener: MainListener) => {
      const channelListeners = listeners.get(channel) ?? new Set<MainListener>()
      channelListeners.add(listener)
      listeners.set(channel, channelListeners)
    }),
    off: vi.fn((channel: string, listener: MainListener) => {
      const channelListeners = listeners.get(channel)
      channelListeners?.delete(listener)
      if (channelListeners?.size === 0) listeners.delete(channel)
    }),
    handle: vi.fn((channel: string, handler: MainHandler) => { handlers.set(channel, handler) }),
    removeHandler: vi.fn((channel: string) => { handlers.delete(channel) })
  }
  return { listeners, handlers, ipcMain }
})

vi.mock("electron", () => ({ ipcMain: electron.ipcMain }))
const { bindElectronIpc } = await import("../main")

class Runtime extends Context.Service<Runtime, { readonly label: string }>()("ElectronIpcTestRuntime") {}

const contract = IpcContract.make("main", {
  send: IpcChannel.send({ payload: Schema.String }),
  invoke: IpcChannel.invoke({ payload: Schema.String, success: Schema.Number, error: Schema.String }),
  event: IpcChannel.event({ payload: Schema.Struct({ value: Schema.Number }) }),
  port: IpcChannel.portExchange()
})

const frame = { url: "https://app.example/", detached: false }
const contents = { mainFrame: frame, send: vi.fn(), postMessage: vi.fn() }
const browserWindow = { webContents: contents } as unknown as BrowserWindow
const eventFor = (sender: unknown = contents, senderFrame: unknown = frame) => ({ sender, senderFrame })
const first = <A>(values: ReadonlySet<A>): A => {
  const value = [...values][0]
  if (value === undefined) throw new Error("expected a registered callback")
  return value
}
const options = { window: browserWindow, rendererOrigin: "https://app.example", maxPayloadBytes: 1024 }
const packagedDocumentUrl = "file:///app/index.html"
const automationFragments = [
  "",
  "#/p/project-1/automations",
  "#/p/project-1/automations/integrations",
  "#/p/project-1/automations/routines/new",
  "#/p/project-1/automations/history"
]

const handlers = {
  send: (payload: string, sender: { readonly frameUrl: string }) => Runtime.pipe(
    Effect.flatMap(({ label }) => Effect.sync(() => { sent.push(`${label}:${payload}:${sender.frameUrl}`) }).pipe(Effect.asVoid))
  ),
  invoke: (payload: string) => Runtime.pipe(
    Effect.flatMap(({ label }) => payload === "failure" ? Effect.fail(`${label}:domain`) : Effect.succeed(payload.length))
  ),
  port: (_sender: { readonly frameUrl: string }, grant: (port: MessagePortMain) => Effect.Effect<void>) =>
    Effect.succeed(grant(portValue)).pipe(Effect.flatten)
} satisfies IpcHandlersOf<typeof contract, Runtime, MessagePortMain>

const portValue = { postMessage: vi.fn() } as unknown as MessagePortMain
const sent: Array<string> = []

beforeEach(() => {
  electron.listeners.clear()
  electron.handlers.clear()
  sent.length = 0
  frame.url = "https://app.example/"
  frame.detached = false
  contents.mainFrame = frame
  contents.send.mockReset()
  contents.postMessage.mockReset()
  electron.ipcMain.on.mockReset()
  electron.ipcMain.on.mockImplementation((channel, listener) => {
    const channelListeners = electron.listeners.get(channel) ?? new Set<MainListener>()
    channelListeners.add(listener)
    electron.listeners.set(channel, channelListeners)
  })
  electron.ipcMain.off.mockReset()
  electron.ipcMain.off.mockImplementation((channel, listener) => {
    const channelListeners = electron.listeners.get(channel)
    channelListeners?.delete(listener)
    if (channelListeners?.size === 0) electron.listeners.delete(channel)
  })
  electron.ipcMain.handle.mockReset()
  electron.ipcMain.handle.mockImplementation((channel, handler) => { electron.handlers.set(channel, handler) })
  electron.ipcMain.removeHandler.mockReset()
  electron.ipcMain.removeHandler.mockImplementation((channel) => { electron.handlers.delete(channel) })
})

const bind = (override: Partial<typeof options> = {}) => bindElectronIpc<typeof contract, Runtime>(contract, handlers, { ...options, ...override })
const withRuntime = <A, E>(effect: Effect.Effect<A, E, Runtime>) => effect.pipe(Effect.provideService(Runtime, { label: "injected" }))

describe("main Electron IPC facade", () => {
  it("requires Electron's BrowserWindow and MessagePortMain boundary types", () => {
    type BindOptions = Parameters<typeof bindElectronIpc>[2]
    expectTypeOf<BindOptions["window"]>().toEqualTypeOf<BrowserWindow>()
    expectTypeOf(handlers).toMatchTypeOf<IpcHandlersOf<typeof contract, Runtime, MessagePortMain>>()
  })

  it.effect("rejects missing, dual, malformed, and noncanonical locations", () => Effect.gen(function* () {
    const invalid = [
      { window: browserWindow },
      { ...options, rendererUrl: "file:///app/index.html" },
      { ...options, rendererOrigin: "https://app.example/path" },
      { ...options, rendererOrigin: "https://user:pass@app.example" },
      { ...options, rendererOrigin: "file://" },
      { ...options, rendererOrigin: "https://app.example/" },
      { ...options, rendererUrl: "file:///app/index.html?query" },
      { ...options, rendererUrl: "file:///app/index.html#hash" },
      { window: browserWindow, rendererUrl: "file:/app/index.html" },
      { window: browserWindow, rendererUrl: "file:///app/./index.html" },
      { window: browserWindow, rendererUrl: "file:///app/index.html?query" },
      { window: browserWindow, rendererUrl: "file:///app/index.html#hash" },
      { window: browserWindow, rendererUrl: "file://user:pass@app/index.html" },
      { window: browserWindow, rendererUrl: "https://app.example/index.html" },
      { window: browserWindow, rendererUrl: "not a url" }
    ]
    for (const [index, invalidOptions] of invalid.entries()) {
      const exit = yield* withRuntime(Effect.scoped(bindElectronIpc<typeof contract, Runtime>(contract, handlers, invalidOptions as never)).pipe(Effect.exit))
      expect(Exit.isFailure(exit), `invalid location case ${index}`).toBe(true)
      expect(electron.listeners.size).toBe(0)
      expect(electron.handlers.size).toBe(0)
    }
  }))

  it.effect("rejects every nonpositive, nonfinite, fractional, and unsafe payload cap", () => Effect.gen(function* () {
    for (const maxPayloadBytes of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const exit = yield* withRuntime(Effect.scoped(bind({ maxPayloadBytes })).pipe(Effect.exit))
      expect(Exit.isFailure(exit), String(maxPayloadBytes)).toBe(true)
    }
  }))

  for (const [locationKind, location] of [["rendererUrl", packagedDocumentUrl], ["rendererOrigin", options.rendererOrigin]] as const) {
    for (const delimiter of ["?", "#", "?#", "#?", "?query", "#hash", "?query#", "?#hash", "?query#hash"]) {
      it.effect(`rejects configured ${locationKind} literal delimiter ${delimiter} before IPC registration`, () => Effect.gen(function* () {
        const exit = yield* withRuntime(Effect.scoped(bindElectronIpc<typeof contract, Runtime>(contract, handlers, {
          window: browserWindow,
          [locationKind]: `${location}${delimiter}`
        })).pipe(Effect.exit))
        expect({
          acquisitionFailed: Exit.isFailure(exit),
          onCalls: electron.ipcMain.on.mock.calls.length,
          handleCalls: electron.ipcMain.handle.mock.calls.length,
          listeners: electron.listeners.size,
          handlers: electron.handlers.size,
          offCalls: electron.ipcMain.off.mock.calls.length,
          removeHandlerCalls: electron.ipcMain.removeHandler.mock.calls.length,
          sent: [...sent],
          eventCalls: contents.send.mock.calls.length,
          portGrants: contents.postMessage.mock.calls.length
        }).toEqual({
          acquisitionFailed: true,
          onCalls: 0,
          handleCalls: 0,
          listeners: 0,
          handlers: 0,
          offCalls: 0,
          removeHandlerCalls: 0,
          sent: [],
          eventCalls: 0,
          portGrants: 0
        })
      }))
    }
  }

  for (const [locationKind, location, frameUrl] of [
    ["rendererUrl", packagedDocumentUrl, `${packagedDocumentUrl}#/p/project-1/automations/history`],
    ["rendererUrl", "file:///app/index%3F.html", "file:///app/index%3F.html#/p/project-1/automations/history"],
    ["rendererUrl", "file:///app/index%23.html", "file:///app/index%23.html#/p/project-1/automations/history"],
    ["rendererUrl", "file:///app/index%3F%23.html", "file:///app/index%3F%23.html#/p/project-1/automations/history"],
    ["rendererOrigin", options.rendererOrigin, "https://app.example/other?query#/p/project-1/automations/history"]
  ] as const) {
    it.effect(`binds, uses, and releases canonical ${locationKind} ${location}`, () => Effect.gen(function* () {
      frame.url = frameUrl
      let send: MainListener | undefined
      let port: MainListener | undefined
      yield* withRuntime(Effect.scoped(Effect.gen(function* () {
        yield* bindElectronIpc<typeof contract, Runtime>(contract, handlers, { window: browserWindow, [locationKind]: location })
        expect(electron.ipcMain.on).toHaveBeenCalledTimes(2)
        expect(electron.ipcMain.handle).toHaveBeenCalledTimes(1)
        expect(electron.listeners.size).toBe(2)
        expect(electron.handlers.size).toBe(1)
        send = first(electron.listeners.get("main:send") ?? new Set<MainListener>())
        port = first(electron.listeners.get("main:port:request") ?? new Set<MainListener>())
        const invoke = electron.handlers.get("main:invoke")
        if (invoke === undefined) throw new Error("expected a registered invoke handler")
        send(eventFor(), "trusted")
        expect(yield* Effect.promise(() => invoke(eventFor(), "hello"))).toEqual({ _tag: "IpcSuccess", value: 5 })
        port(eventFor(), { nonce: "trusted" })
        yield* TestClock.adjust("10 millis")
        expect(sent).toEqual([`injected:trusted:${frameUrl}`])
        expect(contents.postMessage).toHaveBeenCalledExactlyOnceWith("main:port:grant", { nonce: "trusted" }, [portValue])
      })))
      expect(electron.listeners.size).toBe(0)
      expect(electron.handlers.size).toBe(0)
      expect(electron.ipcMain.off).toHaveBeenCalledTimes(2)
      expect(electron.ipcMain.off).toHaveBeenCalledWith("main:send", send)
      expect(electron.ipcMain.off).toHaveBeenCalledWith("main:port:request", port)
      expect(electron.ipcMain.removeHandler).toHaveBeenCalledExactlyOnceWith("main:invoke")
      send?.(eventFor(), "released")
      port?.(eventFor(), { nonce: "released" })
      expect(sent).toEqual([`injected:trusted:${frameUrl}`])
      expect(contents.postMessage).toHaveBeenCalledTimes(1)
    }))
  }

  it.effect("binds a canonical exact URL and a canonical nonopaque origin", () => Effect.gen(function* () {
    const fileFrame = { url: "file:///app/index.html", detached: false }
    const fileTarget = { webContents: { mainFrame: fileFrame, send: vi.fn(), postMessage: vi.fn() } } as unknown as BrowserWindow
    yield* withRuntime(Effect.scoped(Effect.gen(function* () {
      yield* bindElectronIpc<typeof contract, Runtime>(contract, handlers, { window: fileTarget, rendererUrl: "file:///app/index.html" })
      expect(electron.listeners.has("main:send")).toBe(true)
    })))
    electron.listeners.clear()
    yield* withRuntime(Effect.scoped(Effect.gen(function* () {
      yield* bind()
      expect(electron.listeners.has("main:send")).toBe(true)
    })))
  }))

  it.effect("admits only the exact sender, live main frame, and trusted location", () => Effect.gen(function* () {
    yield* withRuntime(Effect.scoped(Effect.gen(function* () {
      yield* bind()
      const listener = first(electron.listeners.get("main:send") ?? new Set<MainListener>())
      listener?.(eventFor(contents, frame), "trusted")
      listener?.(eventFor({}, frame), "foreign sender")
      listener?.(eventFor(contents, { url: frame.url, detached: false }), "subframe")
      frame.detached = true
      listener?.(eventFor(contents, frame), "detached")
      frame.detached = false
      frame.url = "https://other.example/"
      listener?.(eventFor(contents, frame), "location mismatch")
      frame.url = "https://app.example/"
      const stale = frame
      contents.mainFrame = { url: frame.url, detached: false }
      listener?.(eventFor(contents, stale), "stale")
      yield* TestClock.adjust("10 millis")
    })))
    expect(sent).toEqual(["injected:trusted:https://app.example/"])
  }))

  for (const fragment of automationFragments) {
    it.effect(`admits trusted packaged send, invoke, and port exchange with fragment ${fragment || "none"}`, () => Effect.gen(function* () {
      frame.url = `${packagedDocumentUrl}${fragment}`
      const nonce = "trusted-nonce"
      let send: MainListener | undefined
      let port: MainListener | undefined
      yield* withRuntime(Effect.scoped(Effect.gen(function* () {
        yield* bindElectronIpc<typeof contract, Runtime>(contract, handlers, {
          window: browserWindow,
          rendererUrl: packagedDocumentUrl
        })
        send = first(electron.listeners.get("main:send") ?? new Set<MainListener>())
        port = first(electron.listeners.get("main:port:request") ?? new Set<MainListener>())
        const invoke = electron.handlers.get("main:invoke")
        if (invoke === undefined) throw new Error("expected a registered invoke handler")
        send(eventFor(), "trusted")
        expect(yield* Effect.promise(() => invoke(eventFor(), "hello"))).toEqual({ _tag: "IpcSuccess", value: 5 })
        expect(yield* Effect.promise(() => invoke(eventFor(), "failure"))).toEqual({ _tag: "IpcFailure", error: "injected:domain" })
        port(eventFor(), { nonce })
        yield* TestClock.adjust("10 millis")
        expect(sent).toEqual([`injected:trusted:${frame.url}`])
        expect(contents.postMessage).toHaveBeenCalledExactlyOnceWith("main:port:grant", { nonce }, [portValue])
      })))
      expect(electron.listeners.size).toBe(0)
      expect(electron.handlers.size).toBe(0)
      send?.(eventFor(), "released")
      port?.(eventFor(), { nonce: "released" })
      expect(sent).toEqual([`injected:trusted:${frame.url}`])
      expect(contents.postMessage).toHaveBeenCalledTimes(1)
    }))
  }

  it.effect("rejects packaged document, path, authority, query, protocol, and parsing attacks on every request channel", () =>
    withRuntime(Effect.scoped(Effect.gen(function* () {
      yield* bindElectronIpc<typeof contract, Runtime>(contract, handlers, { window: browserWindow, rendererUrl: packagedDocumentUrl })
      const send = first(electron.listeners.get("main:send") ?? new Set<MainListener>())
      const port = first(electron.listeners.get("main:port:request") ?? new Set<MainListener>())
      const invoke = electron.handlers.get("main:invoke")
      if (invoke === undefined) throw new Error("expected a registered invoke handler")
      const fragment = "#/p/project-1/automations/history"
      for (const url of [
        "file:///app/hostile.html" + fragment,
        "file:///other/index.html" + fragment,
        "file://attacker/app/index.html" + fragment,
        "file:///app/%69ndex.html" + fragment,
        "file:///app/index.html%2fhostile.html" + fragment,
        "file:///app/index.html%5chostile.html" + fragment,
        `${packagedDocumentUrl}?query${fragment}`,
        `${packagedDocumentUrl}?${fragment}`,
        `${packagedDocumentUrl}?`,
        "https://app.example/index.html" + fragment,
        "https://attacker.example/index.html" + fragment,
        "data:text/html,hostile" + fragment,
        "not a url",
        "file://[invalid/index.html"
      ]) {
        frame.url = url
        send(eventFor(), "hostile")
        port(eventFor(), { nonce: "hostile" })
        expect(yield* Effect.promise(() => invoke(eventFor(), "hostile")), url).toEqual({ _tag: "IpcDefect", message: "sender rejected" })
      }
      yield* TestClock.adjust("10 millis")
      expect(sent).toEqual([])
      expect(contents.postMessage).not.toHaveBeenCalled()
    }))))

  it.effect("rejects foreign senders, subframes, detached, stale, and missing frames on packaged request channels", () =>
    withRuntime(Effect.scoped(Effect.gen(function* () {
      frame.url = `${packagedDocumentUrl}#/p/project-1/automations/history`
      yield* bindElectronIpc<typeof contract, Runtime>(contract, handlers, { window: browserWindow, rendererUrl: packagedDocumentUrl })
      const send = first(electron.listeners.get("main:send") ?? new Set<MainListener>())
      const port = first(electron.listeners.get("main:port:request") ?? new Set<MainListener>())
      const invoke = electron.handlers.get("main:invoke")
      if (invoke === undefined) throw new Error("expected a registered invoke handler")
      const reject = (event: unknown) => Effect.gen(function* () {
        send(event, "hostile")
        port(event, { nonce: "hostile" })
        expect(yield* Effect.promise(() => invoke(event, "hostile"))).toEqual({ _tag: "IpcDefect", message: "sender rejected" })
      })
      yield* reject(eventFor({ mainFrame: frame }, frame))
      yield* reject(eventFor(contents, { url: frame.url, detached: false }))
      yield* reject({ sender: contents, senderFrame: null })
      yield* reject({ sender: contents })
      yield* reject(null)
      frame.detached = true
      yield* reject(eventFor())
      frame.detached = false
      contents.mainFrame = { url: frame.url, detached: false }
      yield* reject(eventFor())
      Reflect.deleteProperty(contents, "mainFrame")
      yield* reject(eventFor())
      contents.mainFrame = frame
      yield* TestClock.adjust("10 millis")
      expect(sent).toEqual([])
      expect(contents.postMessage).not.toHaveBeenCalled()
    }))))

  it.effect("preserves UTF-8 bounds and codecs on packaged fragment request channels", () =>
    withRuntime(Effect.scoped(Effect.gen(function* () {
      frame.url = `${packagedDocumentUrl}#/p/project-1/automations/history`
      yield* bindElectronIpc<typeof contract, Runtime>(contract, handlers, { window: browserWindow, rendererUrl: packagedDocumentUrl, maxPayloadBytes: 16 })
      const send = first(electron.listeners.get("main:send") ?? new Set<MainListener>())
      const port = first(electron.listeners.get("main:port:request") ?? new Set<MainListener>())
      const invoke = electron.handlers.get("main:invoke")
      if (invoke === undefined) throw new Error("expected a registered invoke handler")
      const admittedPayload = "😀".repeat(4)
      const oversizedPayload = "😀".repeat(5)
      send(eventFor(), admittedPayload)
      send(eventFor(), oversizedPayload)
      send(eventFor(), 42)
      expect(yield* Effect.promise(() => invoke(eventFor(), admittedPayload))).toEqual({ _tag: "IpcSuccess", value: 8 })
      expect(yield* Effect.promise(() => invoke(eventFor(), oversizedPayload))).toEqual({ _tag: "IpcDefect", message: "sender rejected" })
      expect(yield* Effect.promise(() => invoke(eventFor(), 42))).toEqual({ _tag: "IpcDefect", message: "internal error" })
      port(eventFor(), { nonce: "éé" })
      port(eventFor(), { nonce: oversizedPayload })
      port(eventFor(), { nonce: 42 })
      yield* TestClock.adjust("10 millis")
      expect(sent).toEqual([`injected:${admittedPayload}:${frame.url}`])
      expect(contents.postMessage).toHaveBeenCalledExactlyOnceWith("main:port:grant", { nonce: "éé" }, [portValue])
    }))))

  it.effect("preserves development origin admission across paths, queries, and fragments on every request channel", () =>
    withRuntime(Effect.scoped(Effect.gen(function* () {
      yield* bind()
      const send = first(electron.listeners.get("main:send") ?? new Set<MainListener>())
      const port = first(electron.listeners.get("main:port:request") ?? new Set<MainListener>())
      const invoke = electron.handlers.get("main:invoke")
      if (invoke === undefined) throw new Error("expected a registered invoke handler")
      frame.url = "https://app.example/other?query#/p/project-1/automations/history"
      const trustedUrl = frame.url
      send(eventFor(), "trusted")
      port(eventFor(), { nonce: "trusted" })
      expect(yield* Effect.promise(() => invoke(eventFor(), "hello"))).toEqual({ _tag: "IpcSuccess", value: 5 })
      for (const url of ["https://app.example:444/", "http://app.example/", "https://attacker.example/", `${packagedDocumentUrl}#/p/project-1/automations/history`]) {
        frame.url = url
        send(eventFor(), "hostile")
        port(eventFor(), { nonce: "hostile" })
        expect(yield* Effect.promise(() => invoke(eventFor(), "hostile")), url).toEqual({ _tag: "IpcDefect", message: "sender rejected" })
      }
      yield* TestClock.adjust("10 millis")
      expect(sent).toEqual([`injected:trusted:${trustedUrl}`])
      expect(contents.postMessage).toHaveBeenCalledExactlyOnceWith("main:port:grant", { nonce: "trusted" }, [portValue])
    }))))

  it.effect("measures admitted payloads in UTF-8 bytes", () => Effect.gen(function* () {
    yield* withRuntime(Effect.scoped(Effect.gen(function* () {
      yield* bind({ maxPayloadBytes: 2 })
      const listener = first(electron.listeners.get("main:send") ?? new Set<MainListener>())
      listener?.(eventFor(), "é")
      listener?.(eventFor(), "😀")
      yield* TestClock.adjust("10 millis")
    })))
    expect(sent).toEqual(["injected:é:https://app.example/"])
  }))

  it.effect("runs decoded send effects with the injected environment", () => Effect.gen(function* () {
    yield* withRuntime(Effect.scoped(Effect.gen(function* () {
      yield* bind()
      const listener = first(electron.listeners.get("main:send") ?? new Set<MainListener>())
      listener?.(eventFor(), "payload")
      yield* TestClock.adjust("10 millis")
    })))
    expect(sent).toEqual(["injected:payload:https://app.example/"])
  }))

  it.effect("returns encoded success, typed failure, and defect envelopes from invoke", () =>
    withRuntime(Effect.scoped(Effect.gen(function* () {
      yield* bind()
      const invoke = electron.handlers.get("main:invoke")
      if (invoke === undefined) throw new Error("expected a registered invoke handler")
      expect(yield* Effect.promise(() => invoke?.(eventFor(), "hello"))).toEqual({ _tag: "IpcSuccess", value: 5 })
      expect(yield* Effect.promise(() => invoke?.(eventFor(), "failure"))).toEqual({ _tag: "IpcFailure", error: "injected:domain" })
      expect(yield* Effect.promise(() => invoke?.(eventFor(), 42))).toEqual({ _tag: "IpcDefect", message: expect.any(String) })
    }))))

  it.effect("encodes event payloads and makes a retained emitter inert after release", () => Effect.gen(function* () {
    let emitter: IpcEmitterOf<typeof contract> | undefined
    yield* withRuntime(Effect.scoped(Effect.gen(function* () {
      emitter = yield* bind()
      emitter?.event({ value: 7 })
      expect(contents.send).toHaveBeenCalledWith("main:event", { value: 7 })
      contents.send.mockClear()
    })))
    emitter?.event({ value: 8 })
    expect(contents.send).not.toHaveBeenCalled()
  }))

  it.effect("removes the exact listeners and handlers on scope release", () => Effect.gen(function* () {
    yield* withRuntime(Effect.scoped(bind()))
    expect(electron.listeners.size).toBe(0)
    expect(electron.handlers.size).toBe(0)
    expect(electron.ipcMain.off).toHaveBeenCalledWith("main:send", expect.any(Function))
    expect(electron.ipcMain.off).toHaveBeenCalledWith("main:port:request", expect.any(Function))
    expect(electron.ipcMain.removeHandler).toHaveBeenCalledWith("main:invoke")
  }))

  it.effect("attempts every disposer when main binding cleanup fails", () => Effect.gen(function* () {
    const cleanupError = new Error("send cleanup failed")
    const originalOff = electron.ipcMain.off.getMockImplementation()
    electron.ipcMain.off.mockImplementation((channel, listener) => {
      originalOff?.(channel, listener)
      if (channel === "main:send") throw cleanupError
    })
    const exit = yield* withRuntime(Effect.scoped(bind()).pipe(Effect.exit))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(electron.ipcMain.off).toHaveBeenCalledWith("main:send", expect.any(Function))
    expect(electron.ipcMain.off).toHaveBeenCalledWith("main:port:request", expect.any(Function))
    expect(electron.ipcMain.removeHandler).toHaveBeenCalledWith("main:invoke")
    expect(electron.listeners.size).toBe(0)
    expect(electron.handlers.size).toBe(0)
  }))

  it.effect("rolls back partial main acquisition and preserves cleanup failures", () => Effect.gen(function* () {
    const acquisitionError = new Error("invoke registration failed")
    const cleanupError = new Error("send rollback failed")
    const originalOff = electron.ipcMain.off.getMockImplementation()
    electron.ipcMain.handle.mockImplementationOnce(() => { throw acquisitionError })
    electron.ipcMain.off.mockImplementation((channel, listener) => {
      originalOff?.(channel, listener)
      throw cleanupError
    })
    const exit = yield* withRuntime(Effect.scoped(bind()).pipe(Effect.exit))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Cause.squash(exit.cause)
      expect(failure).toBeInstanceOf(AggregateError)
      expect((failure as AggregateError).errors).toEqual([acquisitionError, cleanupError])
    }
    expect(electron.listeners.size).toBe(0)
  }))

  it.effect("decodes a port request and transfers the exact MessagePortMain", () => Effect.gen(function* () {
    yield* withRuntime(Effect.scoped(Effect.gen(function* () {
      yield* bind()
      const listener = first(electron.listeners.get("main:port:request") ?? new Set<MainListener>())
      listener?.(eventFor(), { nonce: "nonce-1" })
      yield* TestClock.adjust("10 millis")
    })))
    expect(contents.postMessage).toHaveBeenCalledWith("main:port:grant", { nonce: "nonce-1" }, [portValue])
  }))
})
