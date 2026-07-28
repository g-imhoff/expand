import { it } from "@effect/vitest"
import { Cause, Crypto, Effect, Exit, Fiber, FiberSet, Option, Queue, Ref, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect } from "vitest"
import { IpcChannel, IpcContract } from "@expand/electron-ipc/contract"
import { IpcTransportError, makeIpcClient, type MessageEventLike, type RendererWindowLike } from "@expand/electron-ipc/renderer"

class AddFailed extends Schema.TaggedErrorClass<AddFailed>()("AddFailed", { reason: Schema.String }) {}

const Sample = IpcContract.make("sample", {
  ping: IpcChannel.send({ payload: Schema.Struct({ at: Schema.FiniteFromString }) }),
  add: IpcChannel.invoke({
    payload: Schema.Struct({ a: Schema.FiniteFromString, b: Schema.FiniteFromString }),
    success: Schema.FiniteFromString,
    error: AddFailed
  }),
  tick: IpcChannel.event({ payload: Schema.Struct({ seq: Schema.FiniteFromString }) }),
  rpcPort: IpcChannel.portExchange()
})

type EventListener = (payload: unknown) => void
type WindowListener = (event: MessageEventLike) => void

interface FakeWindow extends RendererWindowLike {
  readonly fire: (event: MessageEventLike) => void
  readonly fireRetained: (event: MessageEventLike) => void
  readonly listenerCount: () => number
  readonly additions: ReadonlyArray<WindowListener>
  readonly removals: ReadonlyArray<WindowListener>
}

const makeFakeWindow = (events: Array<string> = []): FakeWindow => {
  const listeners = new Set<WindowListener>()
  const additions: Array<WindowListener> = []
  const removals: Array<WindowListener> = []
  return {
    addEventListener: (_type, listener) => {
      events.push("window:add")
      additions.push(listener)
      listeners.add(listener)
    },
    removeEventListener: (_type, listener) => {
      events.push("window:remove")
      removals.push(listener)
      listeners.delete(listener)
    },
    fire: (event) => {
      for (const listener of listeners) listener(event)
    },
    fireRetained: (event) => {
      additions.at(-1)?.(event)
    },
    listenerCount: () => listeners.size,
    additions,
    removals
  }
}

interface FakeBridge {
  readonly api: Record<string, unknown>
  readonly sends: Array<unknown>
  readonly invokes: Array<unknown>
  readonly portRequests: Array<string>
  readonly activeEventListeners: Set<EventListener>
  readonly retainedEventListeners: Array<EventListener>
  readonly eventSubscriptions: () => number
  readonly eventUnsubscriptions: () => number
  readonly fireEvent: (payload: unknown) => void
  readonly fireRetainedEvent: (payload: unknown) => void
  readonly setInvoke: (effect: Effect.Effect<unknown, unknown>) => void
  readonly setInvokeThrow: (error: unknown) => void
  readonly setEventSubscribeThrow: (error: unknown) => void
  readonly setEventUnsubscribeThrow: (error: unknown) => void
  readonly setPortRequestThrow: (error: unknown) => void
}

const makeFakeBridge = Effect.fn("ElectronIpcRendererTest.makeBridge")(function* (events: Array<string> = []) {
  const promises = yield* FiberSet.make<unknown, unknown>()
  const runPromise = yield* FiberSet.runtimePromise(promises)<never>()
  const sends: Array<unknown> = []
  const invokes: Array<unknown> = []
  const portRequests: Array<string> = []
  const activeEventListeners = new Set<EventListener>()
  const retainedEventListeners: Array<EventListener> = []
  let subscriptions = 0
  let unsubscriptions = 0
  let invokeEffect: Effect.Effect<unknown, unknown> = Effect.succeed({ _tag: "IpcSuccess", value: "3" })
  let invokeThrow: unknown
  let eventSubscribeThrow: unknown
  let eventUnsubscribeThrow: unknown
  let portRequestThrow: unknown
  const api: Record<string, unknown> = {
    ping: (payload: unknown) => {
      sends.push(payload)
    },
    add: (payload: unknown): unknown => {
      invokes.push(payload)
      if (invokeThrow !== undefined) throw invokeThrow
      return runPromise(invokeEffect)
    },
    tick: (listener: EventListener) => {
      if (eventSubscribeThrow !== undefined) throw eventSubscribeThrow
      subscriptions += 1
      activeEventListeners.add(listener)
      retainedEventListeners.push(listener)
      return () => {
        unsubscriptions += 1
        activeEventListeners.delete(listener)
        if (eventUnsubscribeThrow !== undefined) throw eventUnsubscribeThrow
      }
    },
    rpcPort: (nonce: string) => {
      events.push("bridge:request")
      portRequests.push(nonce)
      if (portRequestThrow !== undefined) throw portRequestThrow
    }
  }
  return {
    api,
    sends,
    invokes,
    portRequests,
    activeEventListeners,
    retainedEventListeners,
    eventSubscriptions: () => subscriptions,
    eventUnsubscriptions: () => unsubscriptions,
    fireEvent: (payload: unknown) => {
      for (const listener of activeEventListeners) listener(payload)
    },
    fireRetainedEvent: (payload: unknown) => {
      retainedEventListeners.at(-1)?.(payload)
    },
    setInvoke: (effect: Effect.Effect<unknown, unknown>) => {
      invokeEffect = effect
    },
    setInvokeThrow: (error: unknown) => {
      invokeThrow = error
    },
    setEventSubscribeThrow: (error: unknown) => {
      eventSubscribeThrow = error
    },
    setEventUnsubscribeThrow: (error: unknown) => {
      eventUnsubscribeThrow = error
    },
    setPortRequestThrow: (error: unknown) => {
      portRequestThrow = error
    }
  }
})

const makeClient = (
  bridge: FakeBridge,
  win: FakeWindow,
  options: { readonly nonce?: Effect.Effect<string, unknown, Crypto.Crypto>; readonly timeoutMillis?: number } = {}
) =>
  makeIpcClient(Sample, {
    bridge: () => bridge.api,
    win,
    nonce: options.nonce ?? Effect.succeed("fixed-nonce"),
    ...(options.timeoutMillis === undefined ? {} : { timeoutMillis: options.timeoutMillis })
  })

const grant = (
  win: FakeWindow,
  source: unknown,
  data: unknown,
  ports: ReadonlyArray<unknown> = [{ fake: "port" }]
) => {
  win.fire({ data, source, ports: ports as ReadonlyArray<MessagePort> })
}

const transportFailure = <A, E>(effect: Effect.Effect<A, E | IpcTransportError>) =>
  Effect.flip(effect).pipe(
    Effect.map((error) => {
      expect(error).toBeInstanceOf(IpcTransportError)
      return error as IpcTransportError
    })
  )

describe("renderer send and invoke", () => {
  it.effect("encodes send payloads and reports a missing bridge member", () =>
    Effect.gen(function* () {
      const bridge = yield* makeFakeBridge()
      const client = makeClient(bridge, makeFakeWindow())
      yield* client.ping({ at: 1 })
      expect(bridge.sends).toEqual([{ at: "1" }])
      const missing = makeIpcClient(Sample, { bridge: () => undefined, win: makeFakeWindow() })
      const error = yield* transportFailure(missing.ping({ at: 1 }))
      expect(error.reason).toBe("bridge-missing")
    }))

  it.effect("encodes invoke payloads and decodes successful envelopes", () =>
    Effect.gen(function* () {
      const bridge = yield* makeFakeBridge()
      const value = yield* makeClient(bridge, makeFakeWindow()).add({ a: 1, b: 2 })
      expect(value).toBe(3)
      expect(bridge.invokes).toEqual([{ a: "1", b: "2" }])
    }))

  it.effect("decodes typed failure envelopes onto the error channel", () =>
    Effect.gen(function* () {
      const bridge = yield* makeFakeBridge()
      bridge.setInvoke(Effect.succeed({ _tag: "IpcFailure", error: { _tag: "AddFailed", reason: "nope" } }))
      const error = yield* Effect.flip(makeClient(bridge, makeFakeWindow()).add({ a: 1, b: 0 }))
      expect(error).toBeInstanceOf(AddFailed)
    }))

  it.effect("turns defect envelopes into sanitized defects", () =>
    Effect.gen(function* () {
      const bridge = yield* makeFakeBridge()
      bridge.setInvoke(Effect.succeed({ _tag: "IpcDefect", message: "internal error" }))
      const exit = yield* Effect.exit(makeClient(bridge, makeFakeWindow()).add({ a: 1, b: 2 }))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(true)
        expect(String(Cause.squash(exit.cause))).toContain("ipc handler defect: internal error")
      }
    }))

  it.effect("maps malformed envelopes and malformed success payloads to decode failures", () =>
    Effect.gen(function* () {
      const bridge = yield* makeFakeBridge()
      const client = makeClient(bridge, makeFakeWindow())
      bridge.setInvoke(Effect.succeed("garbage"))
      expect((yield* transportFailure(client.add({ a: 1, b: 2 }))).reason).toBe("decode")
      bridge.setInvoke(Effect.succeed({ _tag: "IpcSuccess", value: "garbage" }))
      expect((yield* transportFailure(client.add({ a: 1, b: 2 }))).reason).toBe("decode")
    }))

  it.effect("maps synchronous invoke throws and rejected invoke promises to transport failures", () =>
    Effect.gen(function* () {
      const bridge = yield* makeFakeBridge()
      const client = makeClient(bridge, makeFakeWindow())
      bridge.setInvokeThrow(new Error("sync invoke"))
      expect((yield* transportFailure(client.add({ a: 1, b: 2 }))).reason).toBe("transport")
      const rejecting = yield* makeFakeBridge()
      rejecting.setInvoke(Effect.fail("rejected invoke"))
      expect((yield* transportFailure(makeClient(rejecting, makeFakeWindow()).add({ a: 1, b: 2 }))).reason)
        .toBe("transport")
    }))

  it.effect("does not resume or mutate an interrupted invoke after its promise completes", () =>
    Effect.gen(function* () {
      const bridge = yield* makeFakeBridge()
      const started = yield* Queue.make<void>()
      const release = yield* Queue.make<void>()
      const completed = yield* Queue.make<void>()
      const observed = yield* Ref.make(0)
      bridge.setInvoke(
        Queue.offer(started, undefined).pipe(
          Effect.andThen(Queue.take(release)),
          Effect.andThen(Queue.offer(completed, undefined)),
          Effect.as({ _tag: "IpcSuccess", value: "3" })
        )
      )
      const fiber = yield* makeClient(bridge, makeFakeWindow()).add({ a: 1, b: 2 }).pipe(
        Effect.tap(() => Ref.update(observed, (value) => value + 1)),
        Effect.forkChild({ startImmediately: true })
      )
      yield* Queue.take(started)
      yield* Fiber.interrupt(fiber)
      yield* Queue.offer(release, undefined)
      yield* Queue.take(completed)
      yield* Effect.yieldNow
      expect(yield* Ref.get(observed)).toBe(0)
      const exit = yield* Effect.exit(Fiber.join(fiber))
      expect(Exit.isFailure(exit)).toBe(true)
    }))
})

describe("renderer event ownership", () => {
  it.effect("decodes valid events, drops malformed events, and releases once after success", () =>
    Effect.gen(function* () {
      const bridge = yield* makeFakeBridge()
      const client = makeClient(bridge, makeFakeWindow())
      const fiber = yield* Stream.take(client.tick, 2).pipe(
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true })
      )
      yield* Effect.yieldNow
      expect(bridge.eventSubscriptions()).toBe(1)
      bridge.fireEvent({ seq: "1" })
      bridge.fireEvent({ seq: "garbage" })
      bridge.fireEvent({ seq: "2" })
      expect([...(yield* Fiber.join(fiber))]).toEqual([{ seq: 1 }, { seq: 2 }])
      expect(bridge.eventUnsubscriptions()).toBe(1)
      expect(bridge.activeEventListeners.size).toBe(0)
    }))

  it.effect("acquires and releases one exact subscription for every stream run", () =>
    Effect.gen(function* () {
      const bridge = yield* makeFakeBridge()
      const client = makeClient(bridge, makeFakeWindow())
      for (const seq of ["1", "2"]) {
        const fiber = yield* Stream.take(client.tick, 1).pipe(
          Stream.runCollect,
          Effect.forkChild({ startImmediately: true })
        )
        yield* Effect.yieldNow
        bridge.fireEvent({ seq })
        yield* Fiber.join(fiber)
      }
      expect(bridge.eventSubscriptions()).toBe(2)
      expect(bridge.eventUnsubscriptions()).toBe(2)
      expect(bridge.retainedEventListeners).toHaveLength(2)
    }))

  it.effect("releases once on interruption and makes a retained callback inert", () =>
    Effect.gen(function* () {
      const bridge = yield* makeFakeBridge()
      const client = makeClient(bridge, makeFakeWindow())
      const fiber = yield* Stream.runDrain(client.tick).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber)
      expect(bridge.eventUnsubscriptions()).toBe(1)
      expect(bridge.activeEventListeners.size).toBe(0)
      let reads = 0
      const payload = {
        get seq() {
          reads += 1
          return "3"
        }
      }
      bridge.fireRetainedEvent(payload)
      expect(reads).toBe(0)
    }))

  it.effect("maps subscription throws and propagates unsubscribe defects after deactivation", () =>
    Effect.gen(function* () {
      const subscribeBridge = yield* makeFakeBridge()
      subscribeBridge.setEventSubscribeThrow(new Error("subscribe defect"))
      const subscribeExit = yield* Effect.exit(Stream.runDrain(makeClient(subscribeBridge, makeFakeWindow()).tick))
      expect(Exit.isFailure(subscribeExit)).toBe(true)
      if (Exit.isFailure(subscribeExit)) {
        const failure = Option.getOrThrow(Cause.findErrorOption(subscribeExit.cause))
        expect(failure).toBeInstanceOf(IpcTransportError)
      }

      const releaseBridge = yield* makeFakeBridge()
      const releaseDefect = new Error("unsubscribe defect")
      releaseBridge.setEventUnsubscribeThrow(releaseDefect)
      const fiber = yield* Stream.take(makeClient(releaseBridge, makeFakeWindow()).tick, 1).pipe(
        Stream.runDrain,
        Effect.forkChild({ startImmediately: true })
      )
      yield* Effect.yieldNow
      releaseBridge.fireEvent({ seq: "1" })
      const releaseExit = yield* Effect.exit(Fiber.join(fiber))
      expect(Exit.isFailure(releaseExit)).toBe(true)
      if (Exit.isFailure(releaseExit)) expect(Cause.squash(releaseExit.cause)).toBe(releaseDefect)
      expect(releaseBridge.eventUnsubscriptions()).toBe(1)
      let reads = 0
      releaseBridge.fireRetainedEvent({
        get seq() {
          reads += 1
          return "2"
        }
      })
      expect(reads).toBe(0)
    }))
})

describe("renderer port exchange ownership", () => {
  it.effect("uses the Effect Crypto service for the default nonce and accepts an Effect-valued override", () =>
    Effect.gen(function* () {
      const defaultBridge = yield* makeFakeBridge()
      const defaultWindow = makeFakeWindow()
      const crypto = Crypto.Crypto.of({
        randomUUIDv4: Effect.succeed("crypto-nonce")
      } as unknown as Crypto.Crypto)
      const defaultFiber = yield* makeIpcClient(Sample, {
        bridge: () => defaultBridge.api,
        win: defaultWindow
      }).rpcPort.pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.forkChild({ startImmediately: true })
      )
      yield* Effect.yieldNow
      expect(defaultBridge.portRequests).toEqual(["crypto-nonce"])
      grant(defaultWindow, defaultWindow, {
        _tag: "IpcPortGrant",
        channel: "sample:rpcPort",
        nonce: "crypto-nonce"
      })
      yield* Fiber.join(defaultFiber)

      const overrideBridge = yield* makeFakeBridge()
      const overrideWindow = makeFakeWindow()
      const overrideFiber = yield* makeClient(overrideBridge, overrideWindow, {
        nonce: Effect.succeed("effect-nonce")
      }).rpcPort.pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.yieldNow
      expect(overrideBridge.portRequests).toEqual(["effect-nonce"])
      grant(overrideWindow, overrideWindow, {
        _tag: "IpcPortGrant",
        channel: "sample:rpcPort",
        nonce: "effect-nonce"
      })
      yield* Fiber.join(overrideFiber)
    }))

  it.effect("installs the exact listener before requesting and removes it once after a matching grant", () =>
    Effect.gen(function* () {
      const events: Array<string> = []
      const win = makeFakeWindow(events)
      const bridge = yield* makeFakeBridge(events)
      const client = makeClient(bridge, win)
      const port = { fake: "port" } as unknown as MessagePort
      const fiber = yield* client.rpcPort.pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.yieldNow
      expect(events.slice(0, 2)).toEqual(["window:add", "bridge:request"])
      expect(bridge.portRequests).toEqual(["fixed-nonce"])
      grant(win, win, { _tag: "IpcPortGrant", channel: "sample:rpcPort", nonce: "fixed-nonce" }, [port])
      expect(yield* Fiber.join(fiber)).toBe(port)
      expect(win.listenerCount()).toBe(0)
      expect(win.removals).toEqual([win.additions[0]])
    }))

  it.effect("ignores every non-matching grant and accepts the first matching transferred port", () =>
    Effect.gen(function* () {
      const win = makeFakeWindow()
      const bridge = yield* makeFakeBridge()
      const fiber = yield* makeClient(bridge, win).rpcPort.pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.yieldNow
      grant(win, { other: "window" }, { _tag: "IpcPortGrant", channel: "sample:rpcPort", nonce: "fixed-nonce" })
      grant(win, win, { _tag: "Other", channel: "sample:rpcPort", nonce: "fixed-nonce" })
      grant(win, win, { _tag: "IpcPortGrant", channel: "sample:other", nonce: "fixed-nonce" })
      grant(win, win, { _tag: "IpcPortGrant", channel: "sample:rpcPort", nonce: "wrong" })
      grant(win, win, { _tag: "IpcPortGrant", channel: "sample:rpcPort", nonce: "fixed-nonce" }, [])
      grant(win, win, "expand:port")
      yield* Effect.yieldNow
      expect(win.listenerCount()).toBe(1)
      expect(win.removals).toHaveLength(0)
      const port = { accepted: true } as unknown as MessagePort
      grant(win, win, { _tag: "IpcPortGrant", channel: "sample:rpcPort", nonce: "fixed-nonce" }, [port])
      expect(yield* Fiber.join(fiber)).toBe(port)
    }))

  it.effect("maps nonce and request throws to transport failures with exact cleanup", () =>
    Effect.gen(function* () {
      const nonceBridge = yield* makeFakeBridge()
      const nonceWin = makeFakeWindow()
      const nonceError = yield* transportFailure(
        makeClient(nonceBridge, nonceWin, {
          nonce: Effect.fail(new IpcTransportError({ reason: "transport", message: "nonce defect" }))
        }).rpcPort
      )
      expect(nonceError.reason).toBe("transport")
      expect(nonceBridge.portRequests).toEqual([])
      expect(nonceWin.additions).toHaveLength(0)

      const requestBridge = yield* makeFakeBridge()
      const requestWin = makeFakeWindow()
      requestBridge.setPortRequestThrow(new Error("request defect"))
      const requestError = yield* transportFailure(makeClient(requestBridge, requestWin).rpcPort)
      expect(requestError.reason).toBe("transport")
      expect(requestWin.removals).toEqual([requestWin.additions[0]])
      expect(requestWin.listenerCount()).toBe(0)
    }))

  it.effect("fully releases before default and explicit timeout failures are observed", () =>
    Effect.gen(function* () {
      const defaultBridge = yield* makeFakeBridge()
      const defaultWin = makeFakeWindow()
      const defaultFiber = yield* makeClient(defaultBridge, defaultWin).rpcPort.pipe(
        Effect.forkChild({ startImmediately: true })
      )
      yield* TestClock.adjust("9999 millis")
      expect(defaultWin.removals).toHaveLength(0)
      yield* TestClock.adjust("1 millis")
      const defaultExit = yield* Effect.exit(Fiber.join(defaultFiber))
      expect(Exit.isFailure(defaultExit)).toBe(true)
      if (Exit.isFailure(defaultExit)) {
        const error = Option.getOrThrow(Cause.findErrorOption(defaultExit.cause))
        expect(error).toBeInstanceOf(IpcTransportError)
        expect((error as IpcTransportError).reason).toBe("timeout")
      }
      expect(defaultWin.removals).toEqual([defaultWin.additions[0]])

      const explicitBridge = yield* makeFakeBridge()
      const explicitWin = makeFakeWindow()
      const explicitFiber = yield* makeClient(explicitBridge, explicitWin, { timeoutMillis: 25 }).rpcPort.pipe(
        Effect.forkChild({ startImmediately: true })
      )
      yield* TestClock.adjust("24 millis")
      expect(explicitWin.removals).toHaveLength(0)
      yield* TestClock.adjust("1 millis")
      const explicitExit = yield* Effect.exit(Fiber.join(explicitFiber))
      expect(Exit.isFailure(explicitExit)).toBe(true)
      expect(explicitWin.removals).toEqual([explicitWin.additions[0]])
    }))

  it.effect("removes once on interruption and makes the retained listener inert", () =>
    Effect.gen(function* () {
      const bridge = yield* makeFakeBridge()
      const win = makeFakeWindow()
      const fiber = yield* makeClient(bridge, win).rpcPort.pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber)
      expect(win.removals).toEqual([win.additions[0]])
      expect(win.listenerCount()).toBe(0)
      let reads = 0
      const data = {
        get _tag() {
          reads += 1
          return "IpcPortGrant"
        },
        channel: "sample:rpcPort",
        nonce: "fixed-nonce"
      }
      win.fireRetained({ data, source: win, ports: [{ late: true } as unknown as MessagePort] })
      expect(reads).toBe(0)
    }))
})
