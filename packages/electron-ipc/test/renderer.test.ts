import { Deferred, Effect, Exit, Fiber, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { it } from "@effect/vitest"
import { afterAll, beforeEach, describe, expect, vi } from "vitest"
import { IpcChannel, IpcContract } from "../contract"
import { IpcTransportError, makeElectronIpcClient } from "../renderer"

type MessageListener = (event: { readonly source: unknown; readonly data: unknown; readonly ports: ReadonlyArray<MessagePort> }) => void

const contract = IpcContract.make("render", {
  send: IpcChannel.send({ payload: Schema.NumberFromString }),
  invoke: IpcChannel.invoke({ payload: Schema.NumberFromString, success: Schema.NumberFromString, error: Schema.Struct({ code: Schema.String }) }),
  event: IpcChannel.event({ payload: Schema.NumberFromString }),
  port: IpcChannel.portExchange()
})

const listeners = new Set<MessageListener>()
const rendererWindow = {
  addEventListener: vi.fn((_type: "message", listener: MessageListener) => { listeners.add(listener) }),
  removeEventListener: vi.fn((_type: "message", listener: MessageListener) => { listeners.delete(listener) })
}
const bridge = {
  send: vi.fn(),
  invoke: vi.fn<(payload: unknown) => Promise<unknown>>(),
  event: vi.fn<(listener: (payload: unknown) => void) => () => void>(),
  port: vi.fn()
}
const previousWindow = (globalThis as { window?: unknown }).window
const previousCrypto = (globalThis as { crypto?: Crypto }).crypto

const install = (overrides: Record<string, unknown> = {}): void => {
  listeners.clear()
  bridge.send.mockReset()
  bridge.invoke.mockReset()
  bridge.event.mockReset()
  bridge.port.mockReset()
  bridge.invoke.mockResolvedValue({ _tag: "IpcSuccess", value: "3" })
  bridge.event.mockImplementation((_listener) => () => {})
  const nextWindow = Object.assign(rendererWindow, { render: { ...bridge, ...overrides } })
  Object.defineProperty(globalThis, "window", { configurable: true, value: nextWindow })
}

const fire = (event: { readonly source: unknown; readonly data: unknown; readonly ports: ReadonlyArray<MessagePort> }): void => {
  for (const listener of listeners) listener(event)
}

beforeEach(() => { install() })

describe("renderer Electron IPC facade", () => {
  it.effect("executes send Effects with encoded payloads", () => Effect.gen(function* () {
    const client = makeElectronIpcClient(contract)
    yield* client.send(42)
    expect(bridge.send).toHaveBeenCalledWith("42")
  }))

  it.effect("executes invoke Effects and decodes success and typed domain failure", () => Effect.gen(function* () {
    const client = makeElectronIpcClient(contract)
    expect(yield* client.invoke(7)).toBe(3)
    expect(bridge.invoke).toHaveBeenCalledWith("7")
    bridge.invoke.mockResolvedValue({ _tag: "IpcFailure", error: { code: "denied" } })
    const exit = yield* client.invoke(8).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("denied")
  }))

  it.effect("turns bridge throws and rejected invokes into IpcTransportError", () => Effect.gen(function* () {
    bridge.send.mockImplementation(() => { throw new Error("send failed") })
    const sendExit = yield* makeElectronIpcClient(contract).send(1).pipe(Effect.exit)
    expect(Exit.isFailure(sendExit)).toBe(true)
    if (Exit.isFailure(sendExit)) expect(String(sendExit.cause)).toContain("IpcTransportError")
    bridge.invoke.mockRejectedValue(new Error("invoke failed"))
    const invokeExit = yield* makeElectronIpcClient(contract).invoke(1).pipe(Effect.exit)
    expect(Exit.isFailure(invokeExit)).toBe(true)
    if (Exit.isFailure(invokeExit)) expect(String(invokeExit.cause)).toContain("IpcTransportError")
  }))

  it.effect("rejects every strict result envelope violation as IpcTransportError", () => Effect.gen(function* () {
    const inherited = Object.create({ value: "3" }) as Record<string, unknown>
    inherited._tag = "IpcSuccess"
    const malformed: ReadonlyArray<unknown> = [
      { _tag: "IpcSuccess" },
      { _tag: "IpcFailure" },
      { _tag: "IpcSuccess", value: "3", error: "opposite" },
      { _tag: "IpcFailure", error: { code: "x" }, value: "opposite" },
      { _tag: "Unknown", value: "3" },
      { _tag: "IpcDefect", message: "defect", value: "extra" },
      { _tag: "IpcDefect", message: 1 },
      inherited,
      Object.assign(Object.create(null), { _tag: "IpcSuccess", value: "3" })
    ]
    const client = makeElectronIpcClient(contract)
    for (const [index, envelope] of malformed.entries()) {
      bridge.invoke.mockResolvedValueOnce(envelope)
      const exit = yield* client.invoke(1).pipe(Effect.exit)
      expect(Exit.isFailure(exit), `malformed envelope case ${index}`).toBe(true)
      if (Exit.isFailure(exit)) expect(String(exit.cause), `malformed envelope case ${index}`).toContain("IpcTransportError")
    }
  }))

  it.effect("fails an event stream with IpcTransportError and unsubscribes on malformed payload", () => Effect.gen(function* () {
    let eventListener: ((payload: unknown) => void) | undefined
    const subscribed = yield* Deferred.make<void>()
    const unsubscribe = vi.fn(() => { eventListener = undefined })
    bridge.event.mockImplementation((listener) => {
      eventListener = listener
      Deferred.doneUnsafe(subscribed, Effect.void)
      return unsubscribe
    })
    const client = makeElectronIpcClient(contract)
    const fiber = yield* Effect.scoped(Stream.runCollect(client.event)).pipe(Effect.forkChild({ startImmediately: true }))
    yield* Deferred.await(subscribed)
    if (eventListener === undefined) throw new Error("expected event subscription")
    eventListener({ malformed: true })
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("IpcTransportError")
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(eventListener).toBeUndefined()
  }))

  it.effect("preserves malformed event and unsubscribe failures", () => Effect.gen(function* () {
    let eventListener: ((payload: unknown) => void) | undefined
    const subscribed = yield* Deferred.make<void>()
    const unsubscribe = vi.fn(() => { throw new Error("unsubscribe sentinel") })
    bridge.event.mockImplementation((listener) => {
      eventListener = listener
      Deferred.doneUnsafe(subscribed, Effect.void)
      return unsubscribe
    })
    const client = makeElectronIpcClient(contract)
    const fiber = yield* Effect.scoped(Stream.runCollect(client.event)).pipe(Effect.forkChild({ startImmediately: true }))
    yield* Deferred.await(subscribed)
    if (eventListener === undefined) throw new Error("expected event subscription")
    eventListener({ malformed: true })
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const rendered = String(exit.cause)
      expect(rendered).toContain("malformed event payload")
      expect(rendered).toContain("unsubscribe sentinel")
      expect(rendered).toContain("IpcTransportError")
    }
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  }))

  it.effect("uses global crypto internally, sends a generated nonce, and accepts only the matching grant", () => Effect.gen(function* () {
    const random = vi.fn((bytes: Uint8Array) => { bytes.fill(0xab) })
    const accessor = vi.fn(() => "ab".repeat(16))
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: { getRandomValues: random } })
    const port = {} as MessagePort
    bridge.port.mockImplementation((nonce: string) => {
      fire({ source: {}, data: { _tag: "IpcPortGrant", channel: "render:port", nonce }, ports: [port] })
      fire({ source: rendererWindow, data: { _tag: "IpcPortGrant", channel: "other:port", nonce }, ports: [port] })
      fire({ source: rendererWindow, data: { _tag: "IpcPortGrant", channel: "render:port", nonce: "wrong" }, ports: [port] })
      fire({ source: rendererWindow, data: { _tag: "IpcPortGrant", channel: "render:port", nonce, extra: true }, ports: [port] })
      const getter = { _tag: "IpcPortGrant", channel: "render:port" }
      Object.defineProperty(getter, "nonce", { enumerable: true, get: accessor })
      fire({ source: rendererWindow, data: getter, ports: [port] })
      fire({ source: rendererWindow, data: { _tag: "IpcPortGrant", channel: "render:port", nonce }, ports: [port] })
    })
    const acquired = yield* makeElectronIpcClient(contract, { timeoutMillis: 100 }).port
    expect(acquired).toBe(port)
    expect(random).toHaveBeenCalledTimes(1)
    expect(accessor).not.toHaveBeenCalled()
    expect(bridge.port).toHaveBeenCalledWith("ab".repeat(16))
    expect(rendererWindow.removeEventListener).toHaveBeenCalledWith("message", expect.any(Function))
    expect(listeners.size).toBe(0)
  }))

  it.effect("turns port request timeout into IpcTransportError", () => Effect.gen(function* () {
    const fiber = yield* makeElectronIpcClient(contract, { timeoutMillis: 1 }).port.pipe(Effect.forkChild({ startImmediately: true }))
    yield* TestClock.adjust("1 millis")
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("IpcTransportError")
  }))

  it.effect("turns port listener acquisition failure into IpcTransportError before requesting a port", () => Effect.gen(function* () {
    rendererWindow.addEventListener.mockImplementationOnce(() => { throw new Error("listener sentinel") })
    const exit = yield* makeElectronIpcClient(contract).port.pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(String(exit.cause)).toContain("IpcTransportError")
      expect(String(exit.cause)).toContain("listener sentinel")
    }
    expect(bridge.port).not.toHaveBeenCalled()
  }))

  it.effect("validates positive safe integer timeout options and reports missing bridges", () => Effect.gen(function* () {
    for (const timeoutMillis of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => makeElectronIpcClient(contract, { timeoutMillis }), String(timeoutMillis)).toThrow()
    }
    Object.defineProperty(globalThis, "window", { configurable: true, value: { render: {} } })
    const exit = yield* makeElectronIpcClient(contract).send(1).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("IpcTransportError")
  }))
})

afterAll(() => {
  if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window
  else Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  if (previousCrypto === undefined) delete (globalThis as { crypto?: Crypto }).crypto
  else Object.defineProperty(globalThis, "crypto", { configurable: true, value: previousCrypto })
})
