// packages/electron-ipc/test/bind-ipc.test.ts
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { Schema } from "effect"
import { IpcChannel, IpcContract } from "@expand/electron-ipc/contract"
import {
  bindIpc,
  type FrameLike,
  type IpcMainEventLike,
  type IpcMainLike,
  type WindowTargetLike
} from "@expand/electron-ipc/main"

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

const mainFrame: FrameLike = { url: "file:///app/index.html", detached: false }
const webContents = { id: 1 }
const goodEvent: IpcMainEventLike = { sender: webContents, senderFrame: mainFrame }
const evilEvent: IpcMainEventLike = { sender: { id: 666 }, senderFrame: mainFrame }

interface FakeMain {
  readonly ipc: IpcMainLike
  readonly target: WindowTargetLike
  readonly posted: Array<{ channel: string; payload: unknown; transfer: ReadonlyArray<unknown> }>
  readonly fireSend: (channel: string, event: IpcMainEventLike, payload: unknown) => void
  readonly fireInvoke: (channel: string, event: IpcMainEventLike, payload: unknown) => Promise<unknown>
  readonly listenerChannels: () => Array<string>
  readonly handlerChannels: () => Array<string>
}

const makeFakeMain = (): FakeMain => {
  const listeners = new Map<string, (event: IpcMainEventLike, payload: unknown) => void>()
  const handlers = new Map<string, (event: IpcMainEventLike, payload: unknown) => Promise<unknown>>()
  const posted: Array<{ channel: string; payload: unknown; transfer: ReadonlyArray<unknown> }> = []
  return {
    ipc: {
      on: (channel, listener) => listeners.set(channel, listener),
      removeListener: (channel) => listeners.delete(channel),
      handle: (channel, handler) => handlers.set(channel, handler),
      removeHandler: (channel) => handlers.delete(channel)
    },
    target: {
      webContents,
      mainFrame,
      postToRenderer: (channel, payload, transfer) => posted.push({ channel, payload, transfer })
    },
    posted,
    fireSend: (channel, event, payload) => listeners.get(channel)?.(event, payload),
    fireInvoke: (channel, event, payload) =>
      handlers.get(channel)?.(event, payload) ?? Promise.reject(new Error(`no handler for ${channel}`)),
    listenerChannels: () => [...listeners.keys()],
    handlerChannels: () => [...handlers.keys()]
  }
}

const runPromise = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const bindSample = (fake: FakeMain, overrides?: { onPing?: (at: number) => void }) =>
  bindIpc(
    Sample,
    {
      ping: (payload) => Effect.sync(() => overrides?.onPing?.(payload.at)),
      add: (payload) =>
        payload.b === 0
          ? Effect.fail(new AddFailed({ reason: "b is zero" }))
          : payload.b < 0
            ? Effect.die(new Error("secret internal detail"))
            : Effect.succeed(payload.a + payload.b),
      rpcPort: () => Effect.succeed("FAKE_PORT")
    },
    {
      ipc: fake.ipc,
      target: fake.target,
      originRules: [{ _tag: "fileProtocol" }],
      runPromise
    }
  )

describe("bindIpc registration", () => {
  it("registers exactly the registry channels — registry is the allowlist", () => {
    const fake = makeFakeMain()
    bindSample(fake)
    expect(fake.listenerChannels().sort()).toEqual(["sample:ping", "sample:rpcPort:request"])
    expect(fake.handlerChannels()).toEqual(["sample:add"])
  })

  it("unbind removes every listener and handler", () => {
    const fake = makeFakeMain()
    const bound = bindSample(fake)
    bound.unbind()
    expect(fake.listenerChannels()).toEqual([])
    expect(fake.handlerChannels()).toEqual([])
  })
})

describe("send pipeline", () => {
  it("dispatches a valid payload from a valid sender", async () => {
    const fake = makeFakeMain()
    const pings: Array<number> = []
    bindSample(fake, { onPing: (at) => pings.push(at) })
    fake.fireSend("sample:ping", goodEvent, { at: 7 })
    await flush()
    expect(pings).toEqual([7])
  })

  it("silently drops hostile senders and malformed payloads", async () => {
    const fake = makeFakeMain()
    const pings: Array<number> = []
    bindSample(fake, { onPing: (at) => pings.push(at) })
    fake.fireSend("sample:ping", evilEvent, { at: 7 })
    fake.fireSend("sample:ping", goodEvent, { at: "not a number" })
    fake.fireSend("sample:ping", { sender: webContents, senderFrame: null }, { at: 7 })
    await flush()
    expect(pings).toEqual([])
  })
})

describe("invoke pipeline", () => {
  it("returns a Success envelope with the encoded value", async () => {
    const fake = makeFakeMain()
    bindSample(fake)
    await expect(fake.fireInvoke("sample:add", goodEvent, { a: 1, b: 2 })).resolves.toEqual({
      _tag: "IpcSuccess",
      value: 3
    })
  })

  it("returns a Failure envelope with the schema-encoded domain error", async () => {
    const fake = makeFakeMain()
    bindSample(fake)
    const result = (await fake.fireInvoke("sample:add", goodEvent, { a: 1, b: 0 })) as {
      _tag: string
      error: { _tag: string; reason: string }
    }
    expect(result._tag).toBe("IpcFailure")
    expect(result.error._tag).toBe("AddFailed")
    expect(result.error.reason).toBe("b is zero")
  })

  it("sanitizes handler defects — no internal details cross the boundary", async () => {
    const fake = makeFakeMain()
    bindSample(fake)
    const result = (await fake.fireInvoke("sample:add", goodEvent, { a: 1, b: -1 })) as {
      _tag: string
      message: string
    }
    expect(result._tag).toBe("IpcDefect")
    expect(result.message).not.toContain("secret internal detail")
  })

  it("returns a Defect envelope for malformed payloads from a valid sender", async () => {
    const fake = makeFakeMain()
    bindSample(fake)
    const result = (await fake.fireInvoke("sample:add", goodEvent, { a: "x" })) as { _tag: string; message: string }
    expect(result._tag).toBe("IpcDefect")
    expect((result as { message: string }).message).toContain("payload decode failed")
  })

  it("returns undefined (silent) for hostile senders", async () => {
    const fake = makeFakeMain()
    bindSample(fake)
    await expect(fake.fireInvoke("sample:add", evilEvent, { a: 1, b: 2 })).resolves.toBeUndefined()
  })
})

describe("portExchange pipeline", () => {
  it("transfers the handler's port on the grant leg with the request nonce", async () => {
    const fake = makeFakeMain()
    bindSample(fake)
    fake.fireSend("sample:rpcPort:request", goodEvent, { nonce: "n-1" })
    await flush()
    expect(fake.posted).toEqual([
      { channel: "sample:rpcPort:grant", payload: { nonce: "n-1" }, transfer: ["FAKE_PORT"] }
    ])
  })

  it("drops port requests from hostile senders and with malformed nonces", async () => {
    const fake = makeFakeMain()
    bindSample(fake)
    fake.fireSend("sample:rpcPort:request", evilEvent, { nonce: "n-1" })
    fake.fireSend("sample:rpcPort:request", goodEvent, { nonce: 42 })
    fake.fireSend("sample:rpcPort:request", goodEvent, "garbage")
    await flush()
    expect(fake.posted).toEqual([])
  })
})

describe("event emitters", () => {
  it("emit posts the encoded payload on the wire name", () => {
    const fake = makeFakeMain()
    const bound = bindSample(fake)
    bound.emit.tick({ seq: 5 })
    expect(fake.posted).toEqual([{ channel: "sample:tick", payload: { seq: 5 }, transfer: [] }])
  })
})

describe("oversized payloads", () => {
  it("drops send payloads above the cap", async () => {
    const fake = makeFakeMain()
    const pings: Array<number> = []
    bindIpc(
      Sample,
      {
        ping: (payload) => Effect.sync(() => pings.push(payload.at)),
        add: (payload) => Effect.succeed(payload.a + payload.b),
        rpcPort: () => Effect.succeed("FAKE_PORT")
      },
      {
        ipc: fake.ipc,
        target: fake.target,
        originRules: [{ _tag: "fileProtocol" }],
        runPromise,
        maxPayloadBytes: 10
      }
    )
    fake.fireSend("sample:ping", goodEvent, { at: 123456789012345 })
    await flush()
    expect(pings).toEqual([])
  })
})
