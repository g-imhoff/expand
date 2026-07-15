import { it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, Ref, Schema, Scope } from "effect"
import { describe, expect } from "vitest"
import { IpcChannel, IpcContract } from "@expand/electron-ipc/contract"
import {
  bindIpc,
  type FrameLike,
  type IpcMainEventLike,
  type IpcMainLike,
  type WindowTargetLike
} from "@expand/electron-ipc/main"

const waitFor = Deferred.await
const fiberExit = Fiber.await

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

type Listener = Parameters<IpcMainLike["on"]>[1]
type InvokeHandler = Parameters<IpcMainLike["handle"]>[1]

interface FakeMain {
  readonly ipc: IpcMainLike
  readonly target: WindowTargetLike<string>
  readonly posted: Array<{ channel: string; payload: unknown; transfer: ReadonlyArray<unknown> }>
  readonly fire: (channel: string, event: IpcMainEventLike, payload: unknown) => void
  readonly invoke: (channel: string, event: IpcMainEventLike, payload: unknown) => Effect.Effect<unknown, unknown>
  readonly retainedFire: (channel: string, event: IpcMainEventLike, payload: unknown) => void
  readonly retainedInvoke: (channel: string, event: IpcMainEventLike, payload: unknown) => Effect.Effect<unknown, unknown>
  readonly listenerCount: (channel: string) => number
  readonly handlerChannels: () => ReadonlyArray<string>
  readonly setPostDefect: (defect: Error | undefined) => void
  readonly setPostObserver: (observer: (() => void) | undefined) => void
}

const makeFakeMain = (mainFrame: FrameLike, webContents: object): FakeMain => {
  const listeners = new Map<string, Set<Listener>>()
  const handlers = new Map<string, InvokeHandler>()
  const retainedListeners = new Map<string, Listener>()
  const retainedHandlers = new Map<string, InvokeHandler>()
  const posted: Array<{ channel: string; payload: unknown; transfer: ReadonlyArray<unknown> }> = []
  let postDefect: Error | undefined
  let postObserver: (() => void) | undefined
  const ipc: IpcMainLike = {
    on: (channel, listener) => {
      const channelListeners = listeners.get(channel) ?? new Set<Listener>()
      channelListeners.add(listener)
      listeners.set(channel, channelListeners)
      retainedListeners.set(channel, listener)
      let disposed = false
      return () => {
        if (disposed) return
        disposed = true
        channelListeners.delete(listener)
      }
    },
    handle: (channel, handler) => {
      handlers.set(channel, handler)
      retainedHandlers.set(channel, handler)
      let disposed = false
      return () => {
        if (disposed) return
        disposed = true
        if (handlers.get(channel) === handler) handlers.delete(channel)
      }
    }
  }
  const invokeWith = (handler: InvokeHandler | undefined, event: IpcMainEventLike, payload: unknown) =>
    handler === undefined
      ? Effect.die(new Error("missing invoke handler"))
      : Effect.tryPromise(() => handler(event, payload))
  return {
    ipc,
    target: {
      webContents,
      mainFrame,
      postToRenderer: (channel, payload, transfer) => {
        if (postDefect !== undefined) throw postDefect
        posted.push({ channel, payload, transfer })
        postObserver?.()
      }
    },
    posted,
    fire: (channel, event, payload) => {
      for (const listener of listeners.get(channel) ?? []) listener(event, payload)
    },
    invoke: (channel, event, payload) => invokeWith(handlers.get(channel), event, payload),
    retainedFire: (channel, event, payload) => {
      retainedListeners.get(channel)?.(event, payload)
    },
    retainedInvoke: (channel, event, payload) => invokeWith(retainedHandlers.get(channel), event, payload),
    listenerCount: (channel) => listeners.get(channel)?.size ?? 0,
    handlerChannels: () => [...handlers.keys()],
    setPostDefect: (defect) => { postDefect = defect },
    setPostObserver: (observer) => { postObserver = observer }
  }
}

interface BindOverrides {
  readonly ping?: (at: number) => Effect.Effect<void>
  readonly add?: (a: number, b: number) => Effect.Effect<number, AddFailed>
  readonly port?: (
    grant: (port: string) => Effect.Effect<void>
  ) => Effect.Effect<void>
  readonly log?: (message: string, cause: Cause.Cause<unknown> | undefined) => Effect.Effect<void>
  readonly maxPayloadBytes?: number
}

const bindSample = Effect.fn("ElectronIpcMainTest.bindSample")(function* (
  fake: FakeMain,
  overrides: BindOverrides = {}
) {
  return yield* bindIpc(
    Sample,
    {
      ping: (payload) => overrides.ping?.(payload.at) ?? Effect.void,
      add: (payload) =>
        overrides.add?.(payload.a, payload.b) ??
        (payload.b === 0
          ? Effect.fail(new AddFailed({ reason: "b is zero" }))
          : payload.b < 0
            ? Effect.die(new Error("secret internal detail"))
            : Effect.succeed(payload.a + payload.b)),
      rpcPort: (_sender, grant) => overrides.port?.(grant) ?? grant("FAKE_PORT")
    },
    {
      ipc: fake.ipc,
      target: fake.target,
      originRules: [{ _tag: "fileProtocol" }],
      ...(overrides.log === undefined ? {} : { log: overrides.log }),
      ...(overrides.maxPayloadBytes === undefined ? {} : { maxPayloadBytes: overrides.maxPayloadBytes })
    }
  )
})

const makeHarness = () => {
  const mainFrame = { url: "file:///app/index.html", detached: false }
  const webContents = { id: 1 }
  const fake = makeFakeMain(mainFrame, webContents)
  const goodEvent: IpcMainEventLike = { sender: webContents, senderFrame: mainFrame }
  const evilEvent: IpcMainEventLike = { sender: { id: 666 }, senderFrame: mainFrame }
  return { fake, mainFrame, webContents, goodEvent, evilEvent }
}

describe("bindIpc registration and ownership", () => {
  it.effect("registers only the registry allowlist and removes exact registrations", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = makeHarness()
        const unrelated = () => {}
        h.fake.ipc.on("sample:ping", unrelated)
        const scope = yield* Scope.make()
        yield* bindSample(h.fake).pipe(Scope.provide(scope))
        expect(h.fake.listenerCount("sample:ping")).toBe(2)
        expect(h.fake.listenerCount("sample:rpcPort:request")).toBe(1)
        expect(h.fake.handlerChannels()).toEqual(["sample:add"])
        yield* Scope.close(scope, Exit.void)
        expect(h.fake.listenerCount("sample:ping")).toBe(1)
        expect(h.fake.listenerCount("sample:rpcPort:request")).toBe(0)
        expect(h.fake.handlerChannels()).toEqual([])
      })
    ))

  it.effect("makes retained callbacks and emitters inert before removing them", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = makeHarness()
        const calls = yield* Ref.make(0)
        const scope = yield* Scope.make()
        const bound = yield* bindSample(h.fake, {
          ping: () => Ref.update(calls, (value) => value + 1),
          port: (grant) => Ref.update(calls, (value) => value + 1).pipe(Effect.andThen(grant("PORT")))
        }).pipe(Scope.provide(scope))
        yield* Scope.close(scope, Exit.void)
        h.fake.retainedFire("sample:ping", h.goodEvent, { at: 1 })
        h.fake.retainedFire("sample:rpcPort:request", h.goodEvent, { nonce: "late" })
        expect(yield* h.fake.retainedInvoke("sample:add", h.goodEvent, { a: 1, b: 2 })).toBeUndefined()
        bound.emit.tick({ seq: 1 })
        expect(yield* Ref.get(calls)).toBe(0)
        expect(h.fake.posted).toEqual([])
      })
    ))

  it.effect("interrupts active send, port, and invoke fibers on scope close", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = makeHarness()
        const sendStarted = yield* Deferred.make<void>()
        const portStarted = yield* Deferred.make<void>()
        const invokeStarted = yield* Deferred.make<void>()
        const sendInterrupted = yield* Deferred.make<void>()
        const portInterrupted = yield* Deferred.make<void>()
        const invokeInterrupted = yield* Deferred.make<void>()
        const scope = yield* Scope.make()
        yield* bindSample(h.fake, {
          ping: () => Deferred.succeed(sendStarted, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(sendInterrupted, undefined))
          ),
          port: () => Deferred.succeed(portStarted, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(portInterrupted, undefined))
          ),
          add: () => Deferred.succeed(invokeStarted, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(invokeInterrupted, undefined))
          )
        }).pipe(Scope.provide(scope))
        h.fake.fire("sample:ping", h.goodEvent, { at: 1 })
        h.fake.fire("sample:rpcPort:request", h.goodEvent, { nonce: "n" })
        const invokeFiber = yield* h.fake.invoke("sample:add", h.goodEvent, { a: 1, b: 2 }).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        yield* Effect.all([
          waitFor(sendStarted),
          waitFor(portStarted),
          waitFor(invokeStarted)
        ])
        yield* Scope.close(scope, Exit.void)
        yield* Effect.all([
          waitFor(sendInterrupted),
          waitFor(portInterrupted),
          waitFor(invokeInterrupted)
        ])
        expect(Exit.isFailure(yield* fiberExit(invokeFiber))).toBe(true)
      })
    ))
})

describe("bindIpc security pipelines", () => {
  it.effect("snapshots the admitted frame synchronously before the callback fiber yields", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = makeHarness()
        const admitted = yield* Deferred.make<number>()
        yield* bindIpc<typeof Sample, never, string>(
          Sample,
          {
            ping: (_payload, sender) => Deferred.succeed(admitted, sender.frameUrl.length),
            add: (payload) => Effect.succeed(payload.a + payload.b),
            rpcPort: (_sender, grant) => grant("PORT")
          },
          { ipc: h.fake.ipc, target: h.fake.target, originRules: [{ _tag: "fileProtocol" }] }
        )
        h.fake.fire("sample:ping", h.goodEvent, { at: 1 })
        h.mainFrame.detached = true
        expect(yield* waitFor(admitted)).toBe("file:///app/index.html".length)
      })
    ))

  it.effect("silently drops hostile, detached, malformed, and oversized send and port requests", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = makeHarness()
        const calls = yield* Ref.make(0)
        yield* bindSample(h.fake, {
          ping: () => Ref.update(calls, (value) => value + 1),
          port: (grant) => Ref.update(calls, (value) => value + 1).pipe(Effect.andThen(grant("PORT"))),
          maxPayloadBytes: 20
        })
        h.fake.fire("sample:ping", h.evilEvent, { at: 1 })
        h.fake.fire("sample:ping", { sender: h.webContents, senderFrame: null }, { at: 1 })
        h.fake.fire("sample:ping", h.goodEvent, { at: "bad" })
        h.fake.fire("sample:ping", h.goodEvent, { at: 12345678901234567890 })
        h.fake.fire("sample:rpcPort:request", h.evilEvent, { nonce: "n" })
        h.fake.fire("sample:rpcPort:request", h.goodEvent, { nonce: 42 })
        h.fake.fire("sample:rpcPort:request", h.goodEvent, "bad")
        yield* Effect.yieldNow
        expect(yield* Ref.get(calls)).toBe(0)
        expect(h.fake.posted).toEqual([])
      })
    ))
})

describe("bindIpc invoke", () => {
  it.effect("preserves success, typed failure, malformed payload, sanitized defect, and silent hostile envelopes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = makeHarness()
        yield* bindSample(h.fake)
        expect(yield* h.fake.invoke("sample:add", h.goodEvent, { a: 1, b: 2 })).toEqual({
          _tag: "IpcSuccess",
          value: 3
        })
        expect(yield* h.fake.invoke("sample:add", h.goodEvent, { a: 1, b: 0 })).toEqual({
          _tag: "IpcFailure",
          error: { _tag: "AddFailed", reason: "b is zero" }
        })
        const malformed = yield* h.fake.invoke("sample:add", h.goodEvent, { a: "bad", b: 1 })
        expect(malformed).toMatchObject({ _tag: "IpcDefect" })
        expect(String((malformed as { message: unknown }).message)).toContain("payload decode failed")
        expect(yield* h.fake.invoke("sample:add", h.goodEvent, { a: 1, b: -1 })).toEqual({
          _tag: "IpcDefect",
          message: "internal error"
        })
        expect(yield* h.fake.invoke("sample:add", h.evilEvent, { a: 1, b: 2 })).toBeUndefined()
      })
    ))

  it.effect("contains throwing and defective loggers without changing the sanitized envelope", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const throwing = makeHarness()
        yield* bindSample(throwing.fake, { log: () => { throw new Error("logger threw") } })
        expect(yield* throwing.fake.invoke("sample:add", throwing.goodEvent, { a: 1, b: -1 })).toEqual({
          _tag: "IpcDefect",
          message: "internal error"
        })
        const defective = makeHarness()
        yield* bindSample(defective.fake, { log: () => Effect.die(new Error("logger died")) })
        expect(yield* defective.fake.invoke("sample:add", defective.goodEvent, { a: 1, b: -1 })).toEqual({
          _tag: "IpcDefect",
          message: "internal error"
        })
      })
    ))
})

describe("bindIpc port grant and events", () => {
  it.effect("keeps grant inside the handler transaction with the exact nonce and transfer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = makeHarness()
        const events = yield* Ref.make<ReadonlyArray<string>>([])
        const granted = yield* Deferred.make<void>()
        yield* bindSample(h.fake, {
          port: (grant) => Ref.update(events, (values) => [...values, "before"]).pipe(
            Effect.andThen(grant("PORT")),
            Effect.tap(() => Ref.update(events, (values) => [...values, "after"])),
            Effect.tap(() => Deferred.succeed(granted, undefined))
          )
        })
        h.fake.fire("sample:rpcPort:request", h.goodEvent, { nonce: "n-1" })
        yield* waitFor(granted)
        expect(yield* Ref.get(events)).toEqual(["before", "after"])
        expect(h.fake.posted).toEqual([
          { channel: "sample:rpcPort:grant", payload: { nonce: "n-1" }, transfer: ["PORT"] }
        ])
      })
    ))

  it.effect("contains a grant defect and keeps later event emitters owned by the binding scope", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = makeHarness()
        const logged = yield* Deferred.make<void>()
        const scope = yield* Scope.make()
        const bound = yield* bindSample(h.fake, {
          log: () => Deferred.succeed(logged, undefined)
        }).pipe(Scope.provide(scope))
        h.fake.setPostDefect(new Error("transfer failed"))
        h.fake.fire("sample:rpcPort:request", h.goodEvent, { nonce: "n" })
        yield* waitFor(logged)
        h.fake.setPostDefect(undefined)
        const posted = yield* Deferred.make<void>()
        h.fake.setPostObserver(() => { Deferred.doneUnsafe(posted, Effect.void) })
        bound.emit.tick({ seq: 5 })
        yield* waitFor(posted)
        expect(h.fake.posted).toEqual([{ channel: "sample:tick", payload: { seq: 5 }, transfer: [] }])
        yield* Scope.close(scope, Exit.void)
        bound.emit.tick({ seq: 6 })
        expect(h.fake.posted).toHaveLength(1)
      })
    ))
})
