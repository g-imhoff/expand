import { it as effectIt } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Layer, Queue, Ref, Scope, Stream, SubscriptionRef } from "effect"
import { describe, expect, it } from "vitest"
import {
  ClientSession,
  type ClientSessionApi,
  type ConnectionStatus
} from "@expand/client-ts"
import {
  ProjectClient,
  type ProjectClientApi
} from "@expand/client-ts/project"
import { ServerClient } from "@expand/client-ts/server"
import { runRpcServer } from "@expand/desktop/main/rpc/server"
import { buildRendererClient } from "@expand/desktop/renderer/rpc/transport"
import {
  admitRpcIngressFrame,
  isRpcIngressFrame,
  RPC_INGRESS_MAX_FRAME_BYTES,
  RPC_INGRESS_MAX_QUEUED_FRAMES,
  RPC_INGRESS_MAX_RETAINED_BYTES,
  rpcIngressFrameSize
} from "@expand/desktop/shared/rpc/ingress-limits"

type MessageListener = (event: { data: unknown }) => void

const eventually = (label: string, check: () => boolean): Effect.Effect<void> =>
  Effect.gen(function* () {
    let attempts = 0
    while (!check()) {
      if (attempts >= 400) return yield* Effect.die(new Error(`timed out waiting for ${label}`))
      attempts += 1
      yield* Effect.sleep(5)
    }
  })

describe("shared rpc ingress admission", () => {
  it("rejects unsupported frame types at the boundary", () => {
    expect(isRpcIngressFrame("[]")).toBe(true)
    expect(isRpcIngressFrame(new Uint8Array(1))).toBe(true)
    expect(isRpcIngressFrame(42)).toBe(false)
    expect(isRpcIngressFrame(null)).toBe(false)
    expect(isRpcIngressFrame({})).toBe(false)
    for (const data of [42, null, undefined, {}, true]) {
      expect(admitRpcIngressFrame(data, { queuedFrames: 0, retainedBytes: 0 })).toEqual({
        admitted: false,
        reason: "unsupported-frame"
      })
    }
    expect(admitRpcIngressFrame("[]", { queuedFrames: 0, retainedBytes: 0 })).toEqual({
      admitted: true,
      size: 2
    })
    expect(
      admitRpcIngressFrame(new Uint8Array(4), { queuedFrames: 0, retainedBytes: 0 })
    ).toEqual({ admitted: true, size: 4 })
  })

  it("rejects frames larger than the per-frame cap", () => {
    const oversize = "x".repeat(RPC_INGRESS_MAX_FRAME_BYTES + 1)
    expect(admitRpcIngressFrame(oversize, { queuedFrames: 0, retainedBytes: 0 })).toEqual({
      admitted: false,
      reason: "oversize-frame"
    })
    expect(
      admitRpcIngressFrame("x".repeat(RPC_INGRESS_MAX_FRAME_BYTES), {
        queuedFrames: 0,
        retainedBytes: 0
      }).admitted
    ).toBe(true)
    expect(
      admitRpcIngressFrame(new Uint8Array(RPC_INGRESS_MAX_FRAME_BYTES + 1), {
        queuedFrames: 0,
        retainedBytes: 0
      })
    ).toEqual({ admitted: false, reason: "oversize-frame" })
  })

  it("a capacity-plus-one burst cannot exceed the queued-frame bound", () => {
    let load = { queuedFrames: 0, retainedBytes: 0 }
    let admitted = 0
    for (let index = 0; index < RPC_INGRESS_MAX_QUEUED_FRAMES + 1; index += 1) {
      const verdict = admitRpcIngressFrame("[]", load)
      if (verdict.admitted) {
        admitted += 1
        load = { queuedFrames: load.queuedFrames + 1, retainedBytes: load.retainedBytes + verdict.size }
      } else {
        expect(verdict.reason).toBe("queue-overflow")
      }
    }
    expect(admitted).toBe(RPC_INGRESS_MAX_QUEUED_FRAMES)
    expect(load.queuedFrames).toBe(RPC_INGRESS_MAX_QUEUED_FRAMES)
  })

  it("bounds total retained bytes independently of frame count", () => {
    // 0.5 MiB frames stay well under the per-frame cap, so the retained-bytes
    // bound (8 MiB) trips after 16 frames while the 128-frame count bound
    // never comes close.
    const frame = "x".repeat(512 * 1024)
    expect(rpcIngressFrameSize(frame)).toBe(512 * 1024)
    let load = { queuedFrames: 0, retainedBytes: 0 }
    let admitted = 0
    let lastReason: string | null = null
    for (let index = 0; index < 20; index += 1) {
      const verdict = admitRpcIngressFrame(frame, load)
      if (verdict.admitted) {
        admitted += 1
        load = { queuedFrames: load.queuedFrames + 1, retainedBytes: load.retainedBytes + verdict.size }
      } else {
        lastReason = verdict.reason
      }
    }
    expect(admitted).toBe(16)
    expect(load.queuedFrames).toBe(16)
    expect(load.retainedBytes).toBe(RPC_INGRESS_MAX_RETAINED_BYTES)
    expect(lastReason).toBe("queue-overflow")
  })

  it("an accepted burst below the limits stays fully admittable", () => {
    let load = { queuedFrames: 0, retainedBytes: 0 }
    const burst = 64
    for (let index = 0; index < burst; index += 1) {
      const verdict = admitRpcIngressFrame("[]", load)
      expect(verdict.admitted).toBe(true)
      if (verdict.admitted) {
        load = { queuedFrames: load.queuedFrames + 1, retainedBytes: load.retainedBytes + verdict.size }
      }
    }
    expect(load.queuedFrames).toBe(burst)
    expect(rpcIngressFrameSize("[]")).toBe(2)
  })
})

const makeMainLayer = Effect.fn("RpcIngressBoundsTest.makeMainLayer")(function* () {
  const status = yield* SubscriptionRef.make<ConnectionStatus>("connected")
  const session: ClientSessionApi = {
    status,
    current: Effect.die("unused"),
    epochs: Stream.empty
  }
  const project: ProjectClientApi = {
    create: () => Effect.die("unused"),
    rename: () => Effect.die("unused"),
    changeDirectory: () => Effect.die("unused"),
    archive: () => Effect.die("unused"),
    restore: () => Effect.die("unused"),
    setMetadata: () => Effect.die("unused"),
    delete: () => Effect.die("unused"),
    list: () => Effect.succeed({ projects: [], seq: 0 }),
    events: () => Stream.die("unused")
  }
  return { status, project, session } as const
})

const makeMainPort = (started: Queue.Queue<void>, onClose?: () => void) => {
  let active: MessageListener | null = null
  let retained: MessageListener | null = null
  let activeClose: (() => void) | null = null
  const attached: Array<MessageListener> = []
  const detached: Array<MessageListener> = []
  let starts = 0
  let closes = 0
  const port = {
    postMessage: (_message: unknown) => {},
    on: (event: "message" | "close", listener: MessageListener | (() => void)) => {
      if (event === "close") {
        activeClose = listener as () => void
      } else {
        attached.push(listener as MessageListener)
        active = listener as MessageListener
        retained = listener as MessageListener
      }
    },
    off: (event: "message" | "close", listener: MessageListener | (() => void)) => {
      if (event === "close") {
        if (activeClose === listener) activeClose = null
      } else {
        detached.push(listener as MessageListener)
        if (active === listener) active = null
      }
    },
    start: () => {
      starts += 1
      Queue.offerUnsafe(started, undefined)
    },
    close: () => {
      closes += 1
      onClose?.()
    }
  }
  return {
    port,
    attached,
    detached,
    active: () => active,
    retained: () => retained,
    starts: () => starts,
    closes: () => closes
  }
}

const makeRendererPort = (started: Queue.Queue<void>, onClose?: () => void) => {
  let handler: MessageListener | null = null
  let owned: MessageListener | null = null
  let starts = 0
  let closes = 0
  const port = {
    postMessage: (_message: unknown) => {},
    get onmessage() {
      return handler
    },
    set onmessage(listener: MessageListener | null) {
      handler = listener
      if (listener !== null && owned === null) owned = listener
    },
    start: () => {
      starts += 1
      Queue.offerUnsafe(started, undefined)
    },
    close: () => {
      closes += 1
      onClose?.()
    }
  }
  return {
    port,
    handler: () => handler,
    owned: () => owned,
    starts: () => starts,
    closes: () => closes
  }
}

describe("main rpc ingress bounds", () => {
  effectIt.effect("rejects an oversized frame and closes the connection", () =>
    Effect.gen(function* () {
      const started = yield* Queue.unbounded<void>()
      const parts = yield* makeMainLayer()
      const mainLayer = Layer.mergeAll(
        Layer.succeed(ClientSession, parts.session),
        Layer.succeed(ProjectClient, parts.project),
        Layer.succeed(ServerClient, { health: () => Effect.die("unused") })
      )
      const scope = yield* Scope.make()
      const closed = yield* Deferred.make<void>()
      const fake = makeMainPort(started, () => {
        Deferred.doneUnsafe(closed, Effect.void)
      })
      const fiber = yield* runRpcServer(fake.port).pipe(
        Effect.provide(mainLayer),
        Scope.provide(scope),
        Effect.forkChild({ startImmediately: true })
      )
      yield* Queue.take(started)
      fake.active()?.({ data: "x".repeat(RPC_INGRESS_MAX_FRAME_BYTES + 1) })
      yield* Deferred.await(closed)
      expect(fake.active()).toBeNull()
      expect(fake.closes()).toBe(1)
      expect(fake.detached).toEqual(fake.attached)
      expect(() => fake.retained()?.({ data: "late" })).not.toThrow()
      yield* Scope.close(scope, Exit.void)
      expect(fake.closes()).toBe(1)
      yield* Fiber.interrupt(fiber)
    }))

  effectIt.effect("a capacity-plus-one burst closes the connection without exceeding the bound", () =>
    Effect.gen(function* () {
      const started = yield* Queue.unbounded<void>()
      const parts = yield* makeMainLayer()
      const mainLayer = Layer.mergeAll(
        Layer.succeed(ClientSession, parts.session),
        Layer.succeed(ProjectClient, parts.project),
        Layer.succeed(ServerClient, { health: () => Effect.die("unused") })
      )
      const scope = yield* Scope.make()
      const closed = yield* Deferred.make<void>()
      const fake = makeMainPort(started, () => {
        Deferred.doneUnsafe(closed, Effect.void)
      })
      const fiber = yield* runRpcServer(fake.port).pipe(
        Effect.provide(mainLayer),
        Scope.provide(scope),
        Effect.forkChild({ startImmediately: true })
      )
      yield* Queue.take(started)
      const fire = fake.active()
      expect(fire).not.toBeNull()
      // Fully synchronous: the single decoding fiber cannot interleave, so all
      // capacity-plus-one frames hit the admission gate before any drain.
      for (let index = 0; index < RPC_INGRESS_MAX_QUEUED_FRAMES + 1; index += 1) {
        fire?.({ data: "[]" })
      }
      yield* Deferred.await(closed)
      expect(fake.active()).toBeNull()
      expect(fake.closes()).toBe(1)
      expect(fake.detached).toEqual(fake.attached)
      yield* Scope.close(scope, Exit.void)
      yield* Fiber.interrupt(fiber)
    }))

  effectIt.effect("a retained-bytes overflow closes the connection before the count bound", () =>
    Effect.gen(function* () {
      const started = yield* Queue.unbounded<void>()
      const parts = yield* makeMainLayer()
      const mainLayer = Layer.mergeAll(
        Layer.succeed(ClientSession, parts.session),
        Layer.succeed(ProjectClient, parts.project),
        Layer.succeed(ServerClient, { health: () => Effect.die("unused") })
      )
      const scope = yield* Scope.make()
      const closed = yield* Deferred.make<void>()
      const fake = makeMainPort(started, () => {
        Deferred.doneUnsafe(closed, Effect.void)
      })
      const fiber = yield* runRpcServer(fake.port).pipe(
        Effect.provide(mainLayer),
        Scope.provide(scope),
        Effect.forkChild({ startImmediately: true })
      )
      yield* Queue.take(started)
      const fire = fake.active()
      expect(fire).not.toBeNull()
      // 0.5 MiB frames stay under the per-frame cap; the 17th crosses the
      // 8 MiB retained bound while only 17 of 128 frame slots are used.
      const frame = "x".repeat(512 * 1024)
      for (let index = 0; index < 17; index += 1) {
        fire?.({ data: frame })
      }
      yield* Deferred.await(closed)
      expect(fake.active()).toBeNull()
      expect(fake.closes()).toBe(1)
      expect(fake.detached).toEqual(fake.attached)
      yield* Scope.close(scope, Exit.void)
      yield* Fiber.interrupt(fiber)
    }))

  effectIt.effect("unsupported and malformed frames tear down instead of stranding the producer", () =>
    Effect.gen(function* () {
      const started = yield* Queue.unbounded<void>()
      const parts = yield* makeMainLayer()
      const mainLayer = Layer.mergeAll(
        Layer.succeed(ClientSession, parts.session),
        Layer.succeed(ProjectClient, parts.project),
        Layer.succeed(ServerClient, { health: () => Effect.die("unused") })
      )
      const scope = yield* Scope.make()
      const closed = yield* Deferred.make<void>()
      const fake = makeMainPort(started, () => {
        Deferred.doneUnsafe(closed, Effect.void)
      })
      const fiber = yield* runRpcServer(fake.port).pipe(
        Effect.provide(mainLayer),
        Scope.provide(scope),
        Effect.forkChild({ startImmediately: true })
      )
      yield* Queue.take(started)
      fake.active()?.({ data: "{{not-json" })
      yield* Deferred.await(closed)
      expect(fake.active()).toBeNull()
      expect(fake.closes()).toBe(1)
      expect(fake.detached).toEqual(fake.attached)
      // Late frames after teardown are ignored, never buffered on a dead consumer.
      expect(() => fake.retained()?.({ data: "[]" })).not.toThrow()
      expect(() => fake.retained()?.({ data: 42 })).not.toThrow()
      yield* Scope.close(scope, Exit.void)
      yield* Fiber.interrupt(fiber)
    }))

  effectIt.effect("rejects an unsupported frame type at the listener boundary", () =>
    Effect.gen(function* () {
      const started = yield* Queue.unbounded<void>()
      const parts = yield* makeMainLayer()
      const mainLayer = Layer.mergeAll(
        Layer.succeed(ClientSession, parts.session),
        Layer.succeed(ProjectClient, parts.project),
        Layer.succeed(ServerClient, { health: () => Effect.die("unused") })
      )
      const scope = yield* Scope.make()
      const closed = yield* Deferred.make<void>()
      const fake = makeMainPort(started, () => {
        Deferred.doneUnsafe(closed, Effect.void)
      })
      const fiber = yield* runRpcServer(fake.port).pipe(
        Effect.provide(mainLayer),
        Scope.provide(scope),
        Effect.forkChild({ startImmediately: true })
      )
      yield* Queue.take(started)
      fake.active()?.({ data: 42 })
      yield* Deferred.await(closed)
      expect(fake.active()).toBeNull()
      expect(fake.closes()).toBe(1)
      yield* Scope.close(scope, Exit.void)
      yield* Fiber.interrupt(fiber)
    }))

  effectIt.effect("accepted traffic below the limits stays ordered and lossless", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const mainStarted = yield* Queue.unbounded<void>()
        const rendererStarted = yield* Queue.unbounded<void>()
        const mainMessages = yield* Queue.unbounded<unknown>()
        const rendererMessages = yield* Queue.unbounded<unknown>()
        const status = yield* SubscriptionRef.make<ConnectionStatus>("connected")
        const seq = yield* Ref.make(0)
        const mainLayer = Layer.mergeAll(
          Layer.succeed(ClientSession, {
            status,
            current: Effect.die("unused"),
            epochs: Stream.empty
          } satisfies ClientSessionApi),
          Layer.succeed(ProjectClient, {
            create: () => Effect.die("unused"),
            rename: () => Effect.die("unused"),
            changeDirectory: () => Effect.die("unused"),
            archive: () => Effect.die("unused"),
            restore: () => Effect.die("unused"),
            setMetadata: () => Effect.die("unused"),
            delete: () => Effect.die("unused"),
            list: () => Ref.getAndUpdate(seq, (n) => n + 1).pipe(
              Effect.map((n) => ({ projects: [], seq: n }))
            ),
            events: () => Stream.die("unused")
          } satisfies ProjectClientApi),
          Layer.succeed(ServerClient, { health: () => Effect.die("unused") })
        )
        const main = makeMainPort(mainStarted)
        const renderer = makeRendererPort(rendererStarted)
        yield* Effect.forever(
          Queue.take(mainMessages).pipe(
            Effect.tap((data) => Effect.sync(() => main.active()?.({ data })))
          )
        ).pipe(Effect.forkScoped)
        yield* Effect.forever(
          Queue.take(rendererMessages).pipe(
            Effect.tap((data) => Effect.sync(() => renderer.handler()?.({ data })))
          )
        ).pipe(Effect.forkScoped)
        const mainWire = {
          ...main.port,
          postMessage: (message: unknown) => {
            Queue.offerUnsafe(rendererMessages, structuredClone(message))
          }
        }
        const rendererWire = {
          ...renderer.port,
          get onmessage() {
            return renderer.port.onmessage
          },
          set onmessage(listener: MessageListener | null) {
            renderer.port.onmessage = listener
          },
          postMessage: (message: unknown) => {
            Queue.offerUnsafe(mainMessages, structuredClone(message))
          }
        }
        yield* runRpcServer(mainWire).pipe(Effect.provide(mainLayer), Effect.forkScoped)
        yield* Queue.take(mainStarted)
        const rendererScope = yield* Scope.make()
        const client = yield* buildRendererClient(rendererWire).pipe(Scope.provide(rendererScope))
        yield* Queue.take(rendererStarted)
        const seen: Array<number> = []
        for (let index = 0; index < 25; index += 1) {
          const result = yield* client.ProjectList({ includeArchived: true })
          seen.push(result.seq)
        }
        expect(seen).toEqual(Array.from({ length: 25 }, (_, index) => index))
        expect(main.closes()).toBe(0)
        expect(renderer.closes()).toBe(0)
        yield* Scope.close(rendererScope, Exit.void)
      })
    ))
})

describe("renderer rpc ingress bounds", () => {
  effectIt.effect("rejects an oversized frame and closes the connection", () =>
    Effect.gen(function* () {
      const started = yield* Queue.unbounded<void>()
      const scope = yield* Scope.make()
      const closed = yield* Deferred.make<void>()
      const fake = makeRendererPort(started, () => {
        Deferred.doneUnsafe(closed, Effect.void)
      })
      yield* buildRendererClient(fake.port).pipe(Scope.provide(scope))
      yield* Queue.take(started)
      fake.handler()?.({ data: "x".repeat(RPC_INGRESS_MAX_FRAME_BYTES + 1) })
      yield* Deferred.await(closed)
      expect(fake.handler()).toBeNull()
      expect(fake.closes()).toBe(1)
      expect(() => fake.owned()?.({ data: "late" })).not.toThrow()
      yield* Scope.close(scope, Exit.void)
      expect(fake.closes()).toBe(1)
    }))

  effectIt.effect("a capacity-plus-one burst closes the connection without exceeding the bound", () =>
    Effect.gen(function* () {
      const started = yield* Queue.unbounded<void>()
      const scope = yield* Scope.make()
      const closed = yield* Deferred.make<void>()
      const fake = makeRendererPort(started, () => {
        Deferred.doneUnsafe(closed, Effect.void)
      })
      yield* buildRendererClient(fake.port).pipe(Scope.provide(scope))
      yield* Queue.take(started)
      const fire = fake.handler()
      expect(fire).not.toBeNull()
      for (let index = 0; index < RPC_INGRESS_MAX_QUEUED_FRAMES + 1; index += 1) {
        fire?.({ data: "[]" })
      }
      yield* Deferred.await(closed)
      expect(fake.handler()).toBeNull()
      expect(fake.closes()).toBe(1)
      yield* Scope.close(scope, Exit.void)
    }))

  effectIt.effect("unsupported and malformed frames tear down instead of stranding the producer", () =>
    Effect.gen(function* () {
      const started = yield* Queue.unbounded<void>()
      const scope = yield* Scope.make()
      const closed = yield* Deferred.make<void>()
      const fake = makeRendererPort(started, () => {
        Deferred.doneUnsafe(closed, Effect.void)
      })
      yield* buildRendererClient(fake.port).pipe(Scope.provide(scope))
      yield* Queue.take(started)
      fake.handler()?.({ data: "{{not-json" })
      yield* Deferred.await(closed)
      expect(fake.handler()).toBeNull()
      expect(fake.closes()).toBe(1)
      expect(() => fake.owned()?.({ data: "[]" })).not.toThrow()
      yield* Scope.close(scope, Exit.void)
    }))
})
