import { describe, expect, it } from "vitest"
import { Effect, Exit, Fiber, Schema, Stream } from "effect"
import { IpcChannel, IpcContract } from "@yodea/electron-ipc/contract"
import { IpcTransportError, makeIpcClient, type MessageEventLike, type RendererWindowLike } from "@yodea/electron-ipc/renderer"

class AddFailed extends Schema.TaggedErrorClass<AddFailed>()("AddFailed", { reason: Schema.String }) {}

const Sample = IpcContract.make("sample", {
  ping: IpcChannel.send({ payload: Schema.Struct({ at: Schema.Number }) }),
  add: IpcChannel.invoke({
    payload: Schema.Struct({ a: Schema.Number, b: Schema.Number }),
    success: Schema.Number,
    error: AddFailed
  }),
  tick: IpcChannel.event({ payload: Schema.Struct({ seq: Schema.Number }) }),
  rpcPort: IpcChannel.portExchange()
})

interface FakeWindow extends RendererWindowLike {
  fire: (event: MessageEventLike) => void
}

const makeFakeWindow = (): FakeWindow => {
  const listeners = new Set<(event: MessageEventLike) => void>()
  const win: FakeWindow = {
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
    fire: (event) => listeners.forEach((listener) => listener(event))
  }
  return win
}

interface FakeBridge {
  api: Record<string, unknown>
  readonly sends: Array<unknown>
  readonly portRequests: Array<string>
  readonly eventListeners: Array<(payload: unknown) => void>
  invokeResult: unknown
}

const makeFakeBridge = (): FakeBridge => {
  const bridge: FakeBridge = {
    sends: [],
    portRequests: [],
    eventListeners: [],
    invokeResult: { _tag: "IpcSuccess", value: 3 },
    api: {}
  }
  bridge.api = {
    ping: (payload: unknown) => bridge.sends.push(payload),
    add: (_payload: unknown) => Promise.resolve(bridge.invokeResult),
    tick: (listener: (payload: unknown) => void) => {
      bridge.eventListeners.push(listener)
      return () => {
        bridge.eventListeners.splice(bridge.eventListeners.indexOf(listener), 1)
      }
    },
    rpcPort: (nonce: string) => bridge.portRequests.push(nonce)
  }
  return bridge
}

const makeClient = (bridge: FakeBridge, win: FakeWindow) =>
  makeIpcClient(Sample, {
    bridge: () => bridge.api,
    win,
    nonce: () => "fixed-nonce",
    timeoutMillis: 200
  })

describe("send", () => {
  it("encodes and forwards through the bridge", async () => {
    const bridge = makeFakeBridge()
    const client = makeClient(bridge, makeFakeWindow())
    await Effect.runPromise(client.ping({ at: 1 }))
    expect(bridge.sends).toEqual([{ at: 1 }])
  })

  it("fails with bridge-missing when the bridge lacks the function", async () => {
    const client = makeIpcClient(Sample, { bridge: () => undefined, win: makeFakeWindow() })
    const exit = await Effect.runPromiseExit(client.ping({ at: 1 }))
    expect(Exit.isFailure(exit)).toBe(true)
    const error = await Effect.runPromise(Effect.flip(client.ping({ at: 1 })))
    expect(error).toBeInstanceOf(IpcTransportError)
    expect((error as IpcTransportError).reason).toBe("bridge-missing")
  })
})

describe("invoke envelope routing", () => {
  it("decodes Success envelopes to the success type", async () => {
    const bridge = makeFakeBridge()
    const client = makeClient(bridge, makeFakeWindow())
    await expect(Effect.runPromise(client.add({ a: 1, b: 2 }))).resolves.toBe(3)
  })

  it("decodes Failure envelopes onto the typed error channel", async () => {
    const bridge = makeFakeBridge()
    bridge.invokeResult = { _tag: "IpcFailure", error: { _tag: "AddFailed", reason: "nope" } }
    const client = makeClient(bridge, makeFakeWindow())
    const exit = await Effect.runPromiseExit(client.add({ a: 1, b: 0 }))
    expect(Exit.isFailure(exit)).toBe(true)
    const error = await Effect.runPromise(Effect.flip(client.add({ a: 1, b: 0 })))
    expect(error).toBeInstanceOf(AddFailed)
  })

  it("dies on Defect envelopes", async () => {
    const bridge = makeFakeBridge()
    bridge.invokeResult = { _tag: "IpcDefect", message: "internal error" }
    const client = makeClient(bridge, makeFakeWindow())
    const exit = await Effect.runPromiseExit(client.add({ a: 1, b: 2 }))
    expect(Exit.isFailure(exit)).toBe(true)
    const flipped = await Effect.runPromiseExit(Effect.flip(client.add({ a: 1, b: 2 })))
    expect(Exit.isFailure(flipped)).toBe(true) // defect, not a typed failure → flip also fails
  })

  it("fails with a transport error on malformed envelopes", async () => {
    const bridge = makeFakeBridge()
    bridge.invokeResult = "garbage"
    const client = makeClient(bridge, makeFakeWindow())
    const error = await Effect.runPromise(Effect.flip(client.add({ a: 1, b: 2 })))
    expect(error).toBeInstanceOf(IpcTransportError)
    expect((error as IpcTransportError).reason).toBe("decode")
  })
})

describe("event stream", () => {
  it("decodes inbound events and drops malformed ones, stream stays alive", async () => {
    const bridge = makeFakeBridge()
    const client = makeClient(bridge, makeFakeWindow())
    const collected = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Stream.take(client.tick, 2).pipe(Stream.runCollect))
        // Deterministically wait for the forked stream to subscribe (bridge registers a
        // listener on acquire) before firing — a fixed sleep races under load. Bounded poll
        // (~1000 iterations of 1ms) so a genuine never-subscribe regression still fails fast.
        yield* Effect.repeat(Effect.sleep("1 millis"), {
          until: () => bridge.eventListeners.length > 0,
          times: 1000
        })
        // fire: good, malformed (dropped), good
        bridge.eventListeners.forEach((l) => l({ seq: 1 }))
        bridge.eventListeners.forEach((l) => l({ seq: "garbage" }))
        bridge.eventListeners.forEach((l) => l({ seq: 2 }))
        return yield* Fiber.join(fiber)
      })
    )
    expect([...collected]).toEqual([{ seq: 1 }, { seq: 2 }])
  })
})

describe("portExchange acquire", () => {
  const grant = (win: FakeWindow, source: unknown, data: unknown, ports: ReadonlyArray<unknown> = [{ fake: "port" }]) =>
    win.fire({ data, source, ports: ports as ReadonlyArray<MessagePort> })

  it("resolves with the port on a matching grant from the same window", async () => {
    const bridge = makeFakeBridge()
    const win = makeFakeWindow()
    const client = makeClient(bridge, win)
    const fiber = Effect.runFork(client.rpcPort)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(bridge.portRequests).toEqual(["fixed-nonce"])
    grant(win, win, { _tag: "IpcPortGrant", channel: "sample:rpcPort", nonce: "fixed-nonce" })
    const exit = await Effect.runPromiseExit(Fiber.join(fiber))
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  it("ignores grants with a foreign source, wrong channel, or wrong nonce", async () => {
    const bridge = makeFakeBridge()
    const win = makeFakeWindow()
    const client = makeClient(bridge, win)
    const fiber = Effect.runFork(client.rpcPort)
    await new Promise((resolve) => setTimeout(resolve, 10))
    grant(win, { other: "window" }, { _tag: "IpcPortGrant", channel: "sample:rpcPort", nonce: "fixed-nonce" })
    grant(win, win, { _tag: "IpcPortGrant", channel: "sample:other", nonce: "fixed-nonce" })
    grant(win, win, { _tag: "IpcPortGrant", channel: "sample:rpcPort", nonce: "wrong" })
    grant(win, win, "yodea:port") // legacy/garbage data
    const exit = await Effect.runPromiseExit(Fiber.join(fiber)) // 200ms timeout
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("times out with an IpcTransportError when no grant arrives", async () => {
    const bridge = makeFakeBridge()
    const client = makeClient(bridge, makeFakeWindow())
    const error = await Effect.runPromise(Effect.flip(client.rpcPort))
    expect(error).toBeInstanceOf(IpcTransportError)
    expect((error as IpcTransportError).reason).toBe("timeout")
  })
})
