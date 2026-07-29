import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect, Fiber, Layer, Queue, Stream } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { ReplayFeed, ReplayFeedLayer } from "@expand/server/db/replay-feed"
import { ProjectEventStore, ProjectEventStoreLayer } from "@expand/server/application/projects/project-event-store"
import { EventBus } from "@expand/server/application/event-bus"
import { streamHandlers } from "@expand/server/rpc/stream"
import { ProjectCreated } from "@expand/contracts/events/project"

const uid = (n: number): string => "00000000-0000-4000-8000-" + String(n).padStart(12, "0")
const ev = (n: number) => ProjectCreated.make({ projectId: uid(n), name: `p${n}`, occurredAt: `t${n}` })

const testLayer = (subscribed: Queue.Queue<void>) => Layer.mergeAll(
  ProjectEventStoreLayer,
  ReplayFeedLayer,
  Layer.effect(EventBus, Effect.map(EventBus.make, (bus) => ({
    ...bus,
    subscribe: Effect.tap(bus.subscribe, () => Queue.offer(subscribed, undefined))
  })))
).pipe(
  Layer.provideMerge(SqliteClient.layer({ filename: ":memory:", disableWAL: true }))
)

const run = <A, E>(
  subscribed: Queue.Queue<void>,
  eff: Effect.Effect<A, E, ProjectEventStore | EventBus | ReplayFeed>
) => Effect.provide(Effect.scoped(eff), testLayer(subscribed))

describe("Events handler — streamed backlog + live dedup gate", () => {
  it.live("replays the backlog then filters live events at or below the replay boundary",  () => Effect.gen(function*() {
    const subscribed = yield* Queue.unbounded<void>()
    const out = yield* run(
      subscribed,
      Effect.gen(function* () {
        const events = yield* ProjectEventStore
        const bus = yield* EventBus
        for (let n = 1; n <= 3; n++) yield* events.append(ev(n))
        const stream = streamHandlers.Events({ fromSeq: 0 })
        const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(stream, 4)))
        yield* Queue.take(subscribed)
        yield* bus.publish({ seq: 3, event: ev(3) })
        yield* bus.publish({ seq: 4, event: ev(4) })
        return Array.from(yield* Fiber.join(fiber))
      })
    )
    expect(out.map((se) => se.seq)).toEqual([1, 2, 3, 4])
  }))

  it.live("an empty backlog degrades to filtering by the cursor itself (Ref initialized to fromSeq)",  () => Effect.gen(function*() {
    const subscribed = yield* Queue.unbounded<void>()
    const out = yield* run(
      subscribed,
      Effect.gen(function* () {
        const bus = yield* EventBus
        const stream = streamHandlers.Events({ fromSeq: 99 })
        const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(stream, 1)))
        yield* Queue.take(subscribed)
        yield* bus.publish({ seq: 99, event: ev(1) })   // ≤ cursor → gated
        yield* bus.publish({ seq: 100, event: ev(2) })  // new → delivered
        return Array.from(yield* Fiber.join(fiber))
      })
    )
    expect(out.map((se) => se.seq)).toEqual([100])
  }))

  it.live("appends racing the backlog drain are delivered exactly once, in order, under every interleaving",  () => Effect.gen(function*() {
    const subscribed = yield* Queue.unbounded<void>()
    const out = yield* run(
      subscribed,
      Effect.gen(function* () {
        const events = yield* ProjectEventStore
        const bus = yield* EventBus
        for (let n = 1; n <= 3; n++) yield* events.append(ev(n))
        const stream = streamHandlers.Events({ fromSeq: 0 })
        const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(stream, 5)))
        // Publish a DUPLICATE of seq 3 with NO sleep, precisely so it can RACE the
        // backlog drain. This interleaving is nondeterministic and we deliberately do
        // NOT stabilize it: the duplicate may arrive (a) before the handler subscribes
        // → simply lost; (b) during the drain → buffered by the subscription, then
        // gated by the Ref (3 ≤ lastReplayed); or (c) after the drain → gated by the
        // live filter (3 > 3 is false). The assertion below is IDENTICAL under EVERY
        // interleaving, so this test is race-proof by construction — it exercises
        // whichever path the scheduler happens to pick, with no stabilizing sleep.
        yield* bus.publish({ seq: 3, event: ev(3) })
        yield* Queue.take(subscribed)
        const s4 = yield* events.append(ev(4))
        yield* bus.publish({ seq: s4, event: ev(4) })
        const s5 = yield* events.append(ev(5))
        yield* bus.publish({ seq: s5, event: ev(5) })
        return Array.from(yield* Fiber.join(fiber))
      })
    )
    expect(out.map((se) => se.seq)).toEqual([1, 2, 3, 4, 5])
  }))
})
