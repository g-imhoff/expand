import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect, Fiber, Layer, Option, Ref, Stream } from "effect"
import { EventBus, DEFAULT_EVENT_BUS_LAG_CAPACITY, EventBusLayer, makeEventBusLayer } from "@expand/server/application/event-bus"
import { EventsLagged } from "@expand/contracts/rpc/stream"
import { ProjectEventStore } from "@expand/server/application/projects/project-event-store"
import { ReplayFeed } from "@expand/server/db/replay-feed"
import { streamHandlers } from "@expand/server/rpc/stream"
import { ProjectCreated } from "@expand/contracts/events/project"
import type { ProjectEvent } from "@expand/contracts/events/project"
import type { SequencedEvent } from "@expand/contracts/events/domain"

const uid = (n: number): string => "00000000-0000-4000-8000-" + String(n).padStart(12, "0")
const ev = (n: number) => ProjectCreated.make({ projectId: uid(n), name: `p${n}`, occurredAt: `t${n}` })
const se = (n: number) => ({ seq: n, event: ev(n) })

const CAPACITY = 4

describe("EventBus lag bound", () => {
  it.live("the default layer exposes a finite, documented lag capacity", () => Effect.gen(function* () {
    const capacity = yield* Effect.map(EventBus, (bus) => bus.lagCapacity).pipe(
      Effect.provide(EventBusLayer)
    )
    expect(capacity).toBe(DEFAULT_EVENT_BUS_LAG_CAPACITY)
    expect(Number.isInteger(capacity)).toBe(true)
    expect(capacity).toBeGreaterThan(0)
  }))

  it.live("a stalled subscriber keeps its retained events, then fails explicitly with EventsLagged", () => Effect.gen(function* () {
    const outcome = yield* Effect.gen(function* () {
      const bus = yield* EventBus
      expect(bus.lagCapacity).toBe(CAPACITY)
      const stalled = yield* bus.subscribe
      const healthy = yield* bus.subscribe
      const delivered: Array<number> = []
      for (let n = 1; n <= CAPACITY + 2; n++) {
        yield* bus.publish(se(n))
        delivered.push((yield* healthy.take).seq)
      }
      const salvaged: Array<number> = []
      for (let n = 1; n <= CAPACITY; n++) salvaged.push((yield* stalled.take).seq)
      const failure = yield* Effect.flip(stalled.take)
      const pending = yield* stalled.pending
      return { delivered, salvaged, failure, pending }
    }).pipe(Effect.scoped, Effect.provide(makeEventBusLayer(CAPACITY)))
    expect(outcome.delivered).toEqual([1, 2, 3, 4, 5, 6])
    expect(outcome.salvaged).toEqual([1, 2, 3, 4])
    expect(outcome.failure).toBeInstanceOf(EventsLagged)
    expect(outcome.failure.lagCapacity).toBe(CAPACITY)
    expect(outcome.pending).toBeLessThanOrEqual(CAPACITY)
  }))

  it.live("a stalled subscriber never blocks publication: 100 publishes complete with bounded retention", () => Effect.gen(function* () {
    const outcome = yield* Effect.gen(function* () {
      const bus = yield* EventBus
      const stalled = yield* bus.subscribe
      const fiber = yield* Effect.forkChild(
        Effect.forEach(Array.from({ length: 100 }, (_, i) => i + 1), (n) => bus.publish(se(n)), { discard: true })
      )
      const completed = yield* Fiber.join(fiber).pipe(Effect.timeoutOption("5 seconds"))
      if (Option.isNone(completed)) return yield* Effect.die(new Error("publish blocked by a stalled subscriber"))
      return yield* stalled.pending
    }).pipe(Effect.scoped, Effect.provide(makeEventBusLayer(CAPACITY)))
    expect(outcome).toBeLessThanOrEqual(CAPACITY)
  }))

  it.live("unsubscribing a consumer frees its slot and never disturbs survivors", () => Effect.gen(function* () {
    const outcome = yield* Effect.gen(function* () {
      const bus = yield* EventBus
      const survivor = yield* bus.subscribe
      const before = yield* bus.subscriberCount
      const during = yield* Effect.scoped(Effect.gen(function* () {
        const transient = yield* bus.subscribe
        const count = yield* bus.subscriberCount
        yield* bus.publish(se(1))
        expect((yield* transient.take).seq).toBe(1)
        return count
      }))
      const after = yield* bus.subscriberCount
      const got: Array<number> = [(yield* survivor.take).seq]
      for (let n = 2; n <= 21; n++) {
        yield* bus.publish(se(n))
        got.push((yield* survivor.take).seq)
      }
      return { before, during, after, got }
    }).pipe(Effect.scoped, Effect.provide(makeEventBusLayer(CAPACITY)))
    expect(outcome.before).toBe(1)
    expect(outcome.during).toBe(2)
    expect(outcome.after).toBe(1)
    expect(outcome.got).toEqual(Array.from({ length: 21 }, (_, i) => i + 1))
  }))
})

const memoryLogLayer = Effect.gen(function* () {
  const log = yield* Ref.make<ReadonlyArray<SequencedEvent>>([])
  const append = (event: ProjectEvent): Effect.Effect<number> =>
    Ref.modify(log, (entries) => {
      const seq = entries.length + 1
      return [seq, [...entries, { seq, event }]] as const
    })
  const readFeed = (fromSeq: number) =>
    Stream.fromEffect(Ref.get(log)).pipe(
      Stream.flatMap((entries) => Stream.fromIterable(entries.filter((item) => item.seq > fromSeq)))
    )
  const store = { read: (fromSeq = 0) => readFeed(fromSeq), append }
  const feed = { read: readFeed }
  return Layer.mergeAll(
    Layer.succeed(ProjectEventStore, store),
    Layer.succeed(ReplayFeed, feed),
    makeEventBusLayer(CAPACITY)
  )
})

describe("Events stream lag recovery", () => {
  it.live("a lagged client reconnects from its last confirmed sequence with no event gap", () => Effect.gen(function* () {
    const layers = yield* memoryLogLayer
    const outcome = yield* Effect.scoped(Effect.gen(function* () {
      const events = yield* ProjectEventStore
      const bus = yield* EventBus
      for (let n = 1; n <= 3; n++) {
        const seq = yield* events.append(ev(n))
        expect(seq).toBe(n)
      }
      const pull = yield* Stream.toPull(streamHandlers.Events({ fromSeq: 0 }))
      const confirmed: Array<number> = []
      while (confirmed.length < 2) {
        for (const item of yield* pull) confirmed.push(item.seq)
      }
      for (let n = 4; n <= 8; n++) {
        const seq = yield* events.append(ev(n))
        yield* bus.publish({ seq, event: ev(n) })
      }
      const rest: Array<number> = []
      let failure: unknown = undefined
      while (failure === undefined) {
        const step = yield* Effect.match(pull, {
          onFailure: (error) => ({ _tag: "Halted", error }) as const,
          onSuccess: (chunk) => ({ _tag: "Emitted", chunk }) as const
        })
        if (step._tag === "Halted") {
          failure = step.error
        } else {
          for (const item of step.chunk) rest.push(item.seq)
        }
      }
      const reconnected = yield* Stream.runCollect(Stream.take(streamHandlers.Events({ fromSeq: 7 }), 1)).pipe(
        Effect.map((chunk) => Array.from(chunk).map((item) => item.seq))
      )
      return { confirmed, rest, failure, reconnected }
    }).pipe(Effect.provide(layers)))
    expect(outcome.confirmed).toEqual([1, 2])
    expect(outcome.rest).toEqual([3, 4, 5, 6, 7])
    expect(outcome.failure).toBeInstanceOf(EventsLagged)
    expect(outcome.reconnected).toEqual([8])
  }))
})
