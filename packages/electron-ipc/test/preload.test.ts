import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { IpcChannel, IpcContract } from "@yodea/electron-ipc/contract"
import { exposeBridge, type PreloadIpcDeps, type PreloadIpcEvent } from "@yodea/electron-ipc/preload"

const Sample = IpcContract.make("sample", {
  ping: IpcChannel.send({ payload: Schema.Struct({ at: Schema.Number }) }),
  add: IpcChannel.invoke({
    payload: Schema.Struct({ a: Schema.Number, b: Schema.Number }),
    success: Schema.Number,
    error: Schema.Struct({ _tag: Schema.Literal("AddFailed") })
  }),
  tick: IpcChannel.event({ payload: Schema.Struct({ seq: Schema.Number }) }),
  rpcPort: IpcChannel.portExchange()
})

interface Recorded {
  readonly sends: Array<{ channel: string; payload: unknown }>
  readonly invokes: Array<{ channel: string; payload: unknown }>
  readonly mainWorldPosts: Array<{ message: unknown; transfer: ReadonlyArray<unknown> }>
  readonly exposed: Record<string, unknown>
  readonly listeners: Map<string, Array<(event: PreloadIpcEvent, payload: unknown) => void>>
}

const makeFakeDeps = (): { deps: PreloadIpcDeps; recorded: Recorded } => {
  const recorded: Recorded = { sends: [], invokes: [], mainWorldPosts: [], exposed: {}, listeners: new Map() }
  const deps: PreloadIpcDeps = {
    send: (channel, payload) => recorded.sends.push({ channel, payload }),
    invoke: (channel, payload) => {
      recorded.invokes.push({ channel, payload })
      return Promise.resolve({ _tag: "IpcSuccess", value: 3 })
    },
    on: (channel, listener) => {
      const existing = recorded.listeners.get(channel) ?? []
      recorded.listeners.set(channel, [...existing, listener])
      return () => {
        recorded.listeners.set(channel, (recorded.listeners.get(channel) ?? []).filter((l) => l !== listener))
      }
    },
    exposeInMainWorld: (key, api) => {
      recorded.exposed[key] = api
    },
    postToMainWorld: (message, transfer) => recorded.mainWorldPosts.push({ message, transfer })
  }
  return { deps, recorded }
}

describe("exposeBridge", () => {
  it("exposes exactly one function per registry key, nothing else", () => {
    const { deps, recorded } = makeFakeDeps()
    exposeBridge(Sample, "sample", deps)
    const api = recorded.exposed["sample"] as Record<string, unknown>
    expect(Object.keys(api).sort()).toEqual(["add", "ping", "rpcPort", "tick"])
    for (const value of Object.values(api)) expect(typeof value).toBe("function")
  })

  it("send channels forward the payload on the derived wire name", () => {
    const { deps, recorded } = makeFakeDeps()
    exposeBridge(Sample, "sample", deps)
    const api = recorded.exposed["sample"] as { ping: (payload: unknown) => void }
    api.ping({ at: 1 })
    expect(recorded.sends).toEqual([{ channel: "sample:ping", payload: { at: 1 } }])
  })

  it("invoke channels forward and return the raw envelope promise", async () => {
    const { deps, recorded } = makeFakeDeps()
    exposeBridge(Sample, "sample", deps)
    const api = recorded.exposed["sample"] as { add: (payload: unknown) => Promise<unknown> }
    await expect(api.add({ a: 1, b: 2 })).resolves.toEqual({ _tag: "IpcSuccess", value: 3 })
    expect(recorded.invokes).toEqual([{ channel: "sample:add", payload: { a: 1, b: 2 } }])
  })

  it("event channels subscribe with a payload-only listener and return a working unsubscribe", () => {
    const { deps, recorded } = makeFakeDeps()
    exposeBridge(Sample, "sample", deps)
    const api = recorded.exposed["sample"] as { tick: (l: (payload: unknown) => void) => () => void }
    const received: Array<unknown> = []
    const unsubscribe = api.tick((payload) => received.push(payload))
    const fire = (payload: unknown) =>
      (recorded.listeners.get("sample:tick") ?? []).forEach((l) => l({ ports: [] }, payload))
    fire({ seq: 1 })
    unsubscribe()
    fire({ seq: 2 })
    expect(received).toEqual([{ seq: 1 }]) // listener never sees the IpcRendererEvent
  })

  it("portExchange: request leg sends the nonce, grant leg relays ports to the main world", () => {
    const { deps, recorded } = makeFakeDeps()
    exposeBridge(Sample, "sample", deps)
    const api = recorded.exposed["sample"] as { rpcPort: (nonce: string) => void }

    // The grant relay is registered statically at exposeBridge time, not per request —
    // exactly one listener exists before any rpcPort call is made.
    const grantListeners = recorded.listeners.get("sample:rpcPort:grant") ?? []
    expect(grantListeners.length).toBe(1)

    api.rpcPort("nonce-1")
    expect(recorded.sends).toEqual([{ channel: "sample:rpcPort:request", payload: { nonce: "nonce-1" } }])

    const fakePort = { tag: "port" }
    grantListeners[0]!({ ports: [fakePort] }, { nonce: "nonce-1" })
    expect(recorded.mainWorldPosts).toEqual([
      { message: { _tag: "IpcPortGrant", channel: "sample:rpcPort", nonce: "nonce-1" }, transfer: [fakePort] }
    ])
  })

  it("portExchange grant relay drops malformed grant payloads", () => {
    const { deps, recorded } = makeFakeDeps()
    exposeBridge(Sample, "sample", deps)
    const grantListeners = recorded.listeners.get("sample:rpcPort:grant") ?? []
    grantListeners[0]!({ ports: [] }, { nonce: 42 })
    grantListeners[0]!({ ports: [] }, "garbage")
    expect(recorded.mainWorldPosts).toEqual([])
  })
})
