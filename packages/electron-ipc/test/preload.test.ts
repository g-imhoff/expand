import { it } from "@effect/vitest"
import { Effect, FiberSet, Schema, Scope } from "effect"
import { describe, expect } from "vitest"
import { IpcChannel, IpcContract, type IpcBridgeOf } from "@expand/electron-ipc/contract"
import { exposeBridge, type PreloadIpcDeps, type PreloadIpcEvent } from "@expand/electron-ipc/preload"

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

const MultiPort = IpcContract.make("multi", {
  firstPort: IpcChannel.portExchange(),
  secondPort: IpcChannel.portExchange()
})

type Listener = (event: PreloadIpcEvent, payload: unknown) => void

interface FakeOptions {
  readonly onThrowAt?: number
  readonly lifetimeError?: Error
  readonly disposeDuringLifetimeRegistration?: boolean
  readonly exposeError?: Error
  readonly releaseErrors?: Readonly<Record<string, Error>>
  readonly lifetimeReleaseError?: Error
}

interface Recorded {
  readonly sends: Array<{ channel: string; payload: unknown }>
  readonly invokes: Array<{ channel: string; payload: unknown }>
  readonly mainWorldPosts: Array<{ message: unknown; transfer: ReadonlyArray<unknown> }>
  readonly exposed: Record<string, unknown>
  readonly events: Array<string>
  readonly listeners: Map<string, Set<Listener>>
  readonly retainedListeners: Map<string, Array<Listener>>
  readonly releaseCount: (listener: Listener) => number
  readonly lifetimeRegistrations: () => number
  readonly lifetimeReleases: () => number
  readonly fire: (channel: string, event: PreloadIpcEvent, payload: unknown) => void
  readonly fireRetained: (channel: string, event: PreloadIpcEvent, payload: unknown) => void
  readonly disposeContext: () => void
  readonly disposeRetainedContext: () => void
}

interface FakeDeps {
  readonly deps: PreloadIpcDeps
  readonly recorded: Recorded
  readonly setInvoke: (effect: Effect.Effect<unknown, unknown>) => void
}

const makeFakeDeps = Effect.fn("ElectronIpcPreloadTest.makeDeps")(function* (
  options: FakeOptions = {}
): Effect.fn.Return<FakeDeps, never, Scope.Scope> {
  const promises = yield* FiberSet.make<unknown, unknown>()
  const runPromise = yield* FiberSet.runtimePromise(promises)<never>()
  const sends: Array<{ channel: string; payload: unknown }> = []
  const invokes: Array<{ channel: string; payload: unknown }> = []
  const mainWorldPosts: Array<{ message: unknown; transfer: ReadonlyArray<unknown> }> = []
  const exposed: Record<string, unknown> = {}
  const events: Array<string> = []
  const listeners = new Map<string, Set<Listener>>()
  const retainedListeners = new Map<string, Array<Listener>>()
  const releaseCounts = new Map<Listener, number>()
  let invokeEffect: Effect.Effect<unknown, unknown> = Effect.succeed({ _tag: "IpcSuccess", value: 3 })
  let onCalls = 0
  let lifetimeRegistrations = 0
  let lifetimeReleases = 0
  let activeContextDisposer: (() => void) | undefined
  let retainedContextDisposer: (() => void) | undefined
  const deps = {
    send: (channel, payload) => {
      sends.push({ channel, payload })
    },
    invoke: (channel, payload): unknown => {
      invokes.push({ channel, payload })
      return runPromise(invokeEffect)
    },
    on: (channel, listener) => {
      onCalls += 1
      events.push(`on:${channel}`)
      if (onCalls === options.onThrowAt) throw new Error(`on failed at ${onCalls}`)
      const active = listeners.get(channel) ?? new Set<Listener>()
      active.add(listener)
      listeners.set(channel, active)
      const retained = retainedListeners.get(channel) ?? []
      retained.push(listener)
      retainedListeners.set(channel, retained)
      return () => {
        releaseCounts.set(listener, (releaseCounts.get(listener) ?? 0) + 1)
        active.delete(listener)
        events.push(`off:${channel}`)
        const error = options.releaseErrors?.[channel]
        if (error !== undefined) throw error
      }
    },
    exposeInMainWorld: (key, api) => {
      events.push(`expose:${key}`)
      exposed[key] = api
      if (options.exposeError !== undefined) throw options.exposeError
    },
    postToMainWorld: (message, transfer) => {
      mainWorldPosts.push({ message, transfer })
    },
    onContextDisposed: (dispose) => {
      events.push("context:on")
      lifetimeRegistrations += 1
      if (options.lifetimeError !== undefined) throw options.lifetimeError
      activeContextDisposer = dispose
      retainedContextDisposer = dispose
      const release = () => {
        lifetimeReleases += 1
        if (activeContextDisposer === dispose) activeContextDisposer = undefined
        events.push("context:off")
        if (options.lifetimeReleaseError !== undefined) throw options.lifetimeReleaseError
      }
      if (options.disposeDuringLifetimeRegistration === true) dispose()
      return release
    }
  } as PreloadIpcDeps
  return {
    deps,
    recorded: {
      sends,
      invokes,
      mainWorldPosts,
      exposed,
      events,
      listeners,
      retainedListeners,
      releaseCount: (listener: Listener) => releaseCounts.get(listener) ?? 0,
      lifetimeRegistrations: () => lifetimeRegistrations,
      lifetimeReleases: () => lifetimeReleases,
      fire: (channel: string, event: PreloadIpcEvent, payload: unknown) => {
        for (const listener of listeners.get(channel) ?? []) listener(event, payload)
      },
      fireRetained: (channel: string, event: PreloadIpcEvent, payload: unknown) => {
        retainedListeners.get(channel)?.at(-1)?.(event, payload)
      },
      disposeContext: () => {
        activeContextDisposer?.()
      },
      disposeRetainedContext: () => {
        retainedContextDisposer?.()
      }
    },
    setInvoke: (effect: Effect.Effect<unknown, unknown>) => {
      invokeEffect = effect
    }
  }
})

const captureThrow = (operation: () => unknown): unknown => {
  try {
    operation()
  } catch (error) {
    return error
  }
  throw new Error("operation did not throw")
}

describe("preload bridge surface", () => {
  it.effect("exposes exactly one function per registry key and registers lifetime before exposure", () =>
    Effect.gen(function* () {
      const { deps, recorded } = yield* makeFakeDeps()
      exposeBridge(Sample, "sample", deps)
      const api = recorded.exposed.sample as Record<string, unknown>
      expect(Object.keys(api).sort()).toEqual(["add", "ping", "rpcPort", "tick"])
      expect(Object.values(api).every((value) => typeof value === "function")).toBe(true)
      expect(recorded.events.indexOf("context:on")).toBeLessThan(recorded.events.indexOf("expose:sample"))
    }))

  it.effect("preserves send, invoke, and port request wire behavior", () =>
    Effect.gen(function* () {
      const { deps, recorded } = yield* makeFakeDeps()
      exposeBridge(Sample, "sample", deps)
      const api = recorded.exposed.sample as IpcBridgeOf<typeof Sample>
      api.ping({ at: 1 })
      const envelope = yield* Effect.tryPromise(() => api.add({ a: 1, b: 2 }))
      api.rpcPort("nonce-1")
      expect(envelope).toEqual({ _tag: "IpcSuccess", value: 3 })
      expect(recorded.sends).toEqual([
        { channel: "sample:ping", payload: { at: 1 } },
        { channel: "sample:rpcPort:request", payload: { nonce: "nonce-1" } }
      ])
      expect(recorded.invokes).toEqual([{ channel: "sample:add", payload: { a: 1, b: 2 } }])
    }))

  it.effect("subscribes events with payload-only callbacks", () =>
    Effect.gen(function* () {
      const { deps, recorded } = yield* makeFakeDeps()
      exposeBridge(Sample, "sample", deps)
      const api = recorded.exposed.sample as IpcBridgeOf<typeof Sample>
      const received: Array<unknown> = []
      api.tick((payload) => {
        received.push(payload)
      })
      const rawEvent = { ports: [], secret: "renderer-event" }
      recorded.fire("sample:tick", rawEvent, { seq: 1 })
      expect(received).toEqual([{ seq: 1 }])
      expect(received).not.toContain(rawEvent)
    }))

  it.effect("registers one static relay before requests and validates grants", () =>
    Effect.gen(function* () {
      const { deps, recorded } = yield* makeFakeDeps()
      exposeBridge(Sample, "sample", deps)
      const grants = recorded.retainedListeners.get("sample:rpcPort:grant") ?? []
      expect(grants).toHaveLength(1)
      expect(recorded.sends).toEqual([])
      const port = { tag: "port" }
      recorded.fire("sample:rpcPort:grant", { ports: [port] }, { nonce: "nonce-1" })
      recorded.fire("sample:rpcPort:grant", { ports: [] }, { nonce: 42 })
      recorded.fire("sample:rpcPort:grant", { ports: [] }, "garbage")
      expect(recorded.mainWorldPosts).toEqual([
        {
          message: { _tag: "IpcPortGrant", channel: "sample:rpcPort", nonce: "nonce-1" },
          transfer: [port]
        }
      ])
    }))
})

describe("preload bridge ownership", () => {
  it.effect("returns an idempotent disposer for the static relay and context lifetime", () =>
    Effect.gen(function* () {
      const { deps, recorded } = yield* makeFakeDeps()
      const dispose = exposeBridge(Sample, "sample", deps)
      const relay = recorded.retainedListeners.get("sample:rpcPort:grant")?.[0]
      expect(relay).toBeDefined()
      dispose()
      dispose()
      expect(recorded.releaseCount(relay!)).toBe(1)
      expect(recorded.lifetimeRegistrations()).toBe(1)
      expect(recorded.lifetimeReleases()).toBe(1)
    }))

  it.effect("coordinates caller and bridge release for dynamic subscriptions exactly once", () =>
    Effect.gen(function* () {
      const first = yield* makeFakeDeps()
      const disposeFirst = exposeBridge(Sample, "sample", first.deps)
      const firstApi = first.recorded.exposed.sample as IpcBridgeOf<typeof Sample>
      const unsubscribeFirst = firstApi.tick(() => {})
      const firstListener = first.recorded.retainedListeners.get("sample:tick")?.[0]
      unsubscribeFirst()
      disposeFirst()
      expect(first.recorded.releaseCount(firstListener!)).toBe(1)

      const second = yield* makeFakeDeps()
      const disposeSecond = exposeBridge(Sample, "sample", second.deps)
      const secondApi = second.recorded.exposed.sample as IpcBridgeOf<typeof Sample>
      const unsubscribeSecond = secondApi.tick(() => {})
      const secondListener = second.recorded.retainedListeners.get("sample:tick")?.[0]
      disposeSecond()
      unsubscribeSecond()
      expect(second.recorded.releaseCount(secondListener!)).toBe(1)
    }))

  it.effect("makes retained event and grant callbacks inert before cleanup", () =>
    Effect.gen(function* () {
      const { deps, recorded } = yield* makeFakeDeps()
      const dispose = exposeBridge(Sample, "sample", deps)
      const api = recorded.exposed.sample as IpcBridgeOf<typeof Sample>
      const received: Array<unknown> = []
      api.tick((payload) => {
        received.push(payload)
      })
      dispose()
      let eventReads = 0
      let grantReads = 0
      recorded.fireRetained("sample:tick", { ports: [] }, {
        get seq() {
          eventReads += 1
          return 2
        }
      })
      recorded.fireRetained("sample:rpcPort:grant", { ports: [{ late: true }] }, {
        get nonce() {
          grantReads += 1
          return "late"
        }
      })
      expect(received).toEqual([])
      expect(recorded.mainWorldPosts).toEqual([])
      expect(eventReads).toBe(0)
      expect(grantReads).toBe(0)
    }))

  it.effect("disposes the whole bridge from context lifetime exactly once", () =>
    Effect.gen(function* () {
      const { deps, recorded } = yield* makeFakeDeps()
      const dispose = exposeBridge(Sample, "sample", deps)
      const relay = recorded.retainedListeners.get("sample:rpcPort:grant")?.[0]
      recorded.disposeContext()
      recorded.disposeRetainedContext()
      dispose()
      expect(recorded.releaseCount(relay!)).toBe(1)
      expect(recorded.lifetimeReleases()).toBe(1)
    }))

  it.effect("does not expose or retain ownership after synchronous context disposal", () =>
    Effect.gen(function* () {
      const { deps, recorded } = yield* makeFakeDeps({
        disposeDuringLifetimeRegistration: true
      })
      const dispose = exposeBridge(MultiPort, "multi", deps)
      const firstRelay = recorded.retainedListeners.get("multi:firstPort:grant")?.[0]
      const secondRelay = recorded.retainedListeners.get("multi:secondPort:grant")?.[0]
      expect(recorded.exposed.multi).toBeUndefined()
      expect(recorded.events).not.toContain("expose:multi")
      expect(recorded.releaseCount(firstRelay!)).toBe(1)
      expect(recorded.releaseCount(secondRelay!)).toBe(1)
      expect(recorded.lifetimeReleases()).toBe(1)
      recorded.fireRetained("multi:firstPort:grant", { ports: [{}] }, { nonce: "late-first" })
      recorded.fireRetained("multi:secondPort:grant", { ports: [{}] }, { nonce: "late-second" })
      recorded.disposeRetainedContext()
      dispose()
      dispose()
      expect(recorded.mainWorldPosts).toEqual([])
      expect(recorded.releaseCount(firstRelay!)).toBe(1)
      expect(recorded.releaseCount(secondRelay!)).toBe(1)
      expect(recorded.lifetimeReleases()).toBe(1)
    }))

  it.effect("propagates synchronous lifetime release failure after static cleanup", () =>
    Effect.gen(function* () {
      const lifetimeCause = new Error("synchronous lifetime release failed")
      const { deps, recorded } = yield* makeFakeDeps({
        disposeDuringLifetimeRegistration: true,
        lifetimeReleaseError: lifetimeCause
      })
      expect(captureThrow(() => exposeBridge(MultiPort, "multi", deps))).toBe(lifetimeCause)
      const firstRelay = recorded.retainedListeners.get("multi:firstPort:grant")?.[0]
      const secondRelay = recorded.retainedListeners.get("multi:secondPort:grant")?.[0]
      expect(recorded.events).not.toContain("expose:multi")
      expect(recorded.releaseCount(firstRelay!)).toBe(1)
      expect(recorded.releaseCount(secondRelay!)).toBe(1)
      expect(recorded.lifetimeReleases()).toBe(1)
      recorded.fireRetained("multi:firstPort:grant", { ports: [{}] }, { nonce: "late" })
      recorded.disposeRetainedContext()
      expect(recorded.mainWorldPosts).toEqual([])
      expect(recorded.releaseCount(firstRelay!)).toBe(1)
      expect(recorded.releaseCount(secondRelay!)).toBe(1)
      expect(recorded.lifetimeReleases()).toBe(1)
    }))

  it.effect("rolls back partial static acquisition, lifetime registration failure, and exposure failure", () =>
    Effect.gen(function* () {
      const partial = yield* makeFakeDeps({ onThrowAt: 2 })
      expect(() => exposeBridge(MultiPort, "multi", partial.deps)).toThrow("on failed at 2")
      const partialRelay = partial.recorded.retainedListeners.get("multi:firstPort:grant")?.[0]
      expect(partial.recorded.releaseCount(partialRelay!)).toBe(1)
      partial.recorded.fireRetained("multi:firstPort:grant", { ports: [{}] }, { nonce: "late" })
      expect(partial.recorded.mainWorldPosts).toEqual([])

      const lifetimeCause = new Error("lifetime failed")
      const lifetime = yield* makeFakeDeps({ lifetimeError: lifetimeCause })
      expect(captureThrow(() => exposeBridge(Sample, "sample", lifetime.deps))).toBe(lifetimeCause)
      const lifetimeRelay = lifetime.recorded.retainedListeners.get("sample:rpcPort:grant")?.[0]
      expect(lifetime.recorded.releaseCount(lifetimeRelay!)).toBe(1)

      const exposureCause = new Error("exposure failed")
      const exposure = yield* makeFakeDeps({ exposeError: exposureCause })
      expect(captureThrow(() => exposeBridge(Sample, "sample", exposure.deps))).toBe(exposureCause)
      const exposureRelay = exposure.recorded.retainedListeners.get("sample:rpcPort:grant")?.[0]
      expect(exposure.recorded.releaseCount(exposureRelay!)).toBe(1)
      expect(exposure.recorded.lifetimeReleases()).toBe(1)
      exposure.recorded.fireRetained("sample:rpcPort:grant", { ports: [{}] }, { nonce: "late" })
      expect(exposure.recorded.mainWorldPosts).toEqual([])
    }))

  it.effect("attempts every cleanup and propagates one cause or an aggregate", () =>
    Effect.gen(function* () {
      const singleCause = new Error("second release failed")
      const single = yield* makeFakeDeps({ releaseErrors: { "multi:secondPort:grant": singleCause } })
      const disposeSingle = exposeBridge(MultiPort, "multi", single.deps)
      expect(captureThrow(disposeSingle)).toBe(singleCause)
      const firstRelay = single.recorded.retainedListeners.get("multi:firstPort:grant")?.[0]
      const secondRelay = single.recorded.retainedListeners.get("multi:secondPort:grant")?.[0]
      expect(single.recorded.releaseCount(firstRelay!)).toBe(1)
      expect(single.recorded.releaseCount(secondRelay!)).toBe(1)
      expect(single.recorded.lifetimeReleases()).toBe(1)

      const firstCause = new Error("first release failed")
      const lifetimeCause = new Error("lifetime release failed")
      const multiple = yield* makeFakeDeps({
        releaseErrors: { "multi:firstPort:grant": firstCause },
        lifetimeReleaseError: lifetimeCause
      })
      const thrown = captureThrow(exposeBridge(MultiPort, "multi", multiple.deps))
      expect(thrown).toBeInstanceOf(AggregateError)
      expect((thrown as AggregateError).errors).toEqual([lifetimeCause, firstCause])
      const multipleSecond = multiple.recorded.retainedListeners.get("multi:secondPort:grant")?.[0]
      expect(multiple.recorded.releaseCount(multipleSecond!)).toBe(1)
    }))
})
