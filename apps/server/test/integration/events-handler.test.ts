import { describe, expect, it } from "vitest"
import { Effect, Fiber, Layer, Stream } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { ReplayFeed, ReplayFeedLayer } from "@expand/server/db/replay-feed"
import { ProjectEventStore, ProjectEventStoreLayer } from "@expand/server/application/projects/project-event-store"
import { EventBus, EventBusLayer } from "@expand/server/application/event-bus"
import { streamHandlers } from "@expand/server/rpc/stream"
import { ProjectCreated } from "@expand/contracts/events/project"

const uid = (n: number): string => "00000000-0000-4000-8000-" + String(n).padStart(12, "0")
const ev = (n: number) => ProjectCreated.make({ projectId: uid(n), name: `p${n}`, occurredAt: `t${n}` })

const TestLayer = Layer.mergeAll(ProjectEventStoreLayer, ReplayFeedLayer, EventBusLayer).pipe(
  Layer.provideMerge(SqliteClient.layer({ filename: ":memory:", disableWAL: true }))
)

const run = <A, E>(eff: Effect.Effect<A, E, ProjectEventStore | EventBus | ReplayFeed>) =>
  Effect.runPromise(Effect.provide(Effect.scoped(eff), TestLayer))

describe("Events handler — streamed backlog + live dedup gate", () => {
  it("replays the backlog then filters live events at or below the replay boundary", async () => {
    const out = await run(
      Effect.gen(function* () {
        const events = yield* ProjectEventStore
        const bus = yield* EventBus
        for (let n = 1; n <= 3; n++) yield* events.append(ev(n))
        const stream = streamHandlers.Events({ fromSeq: 0 })
        const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(stream, 4)))
        // Give the handler time to subscribe + drain the backlog, then publish a
        // DUPLICATE of seq 3 (must be gated out) and a genuinely new seq 4.
        // Timing note: the 100ms sleep vastly exceeds the fork→subscribe latency
        // (subscription is the handler's FIRST effect, triggered by the fork's first
        // pull), so BOTH publishes are guaranteed to land AFTER the subscription —
        // the duplicate is then gated by the Ref/filter, never lost pre-subscription.
        // (Were both publishes to land before subscribe, take(4) would HANG, not pass.)
        yield* Effect.sleep(100)
        yield* bus.publish({ seq: 3, event: ev(3) })
        yield* bus.publish({ seq: 4, event: ev(4) })
        return Array.from(yield* Fiber.join(fiber))
      })
    )
    expect(out.map((se) => se.seq)).toEqual([1, 2, 3, 4])
  })

  it("an empty backlog degrades to filtering by the cursor itself (Ref initialized to fromSeq)", async () => {
    const out = await run(
      Effect.gen(function* () {
        const bus = yield* EventBus
        const stream = streamHandlers.Events({ fromSeq: 99 })
        const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(stream, 1)))
        yield* Effect.sleep(100)
        yield* bus.publish({ seq: 99, event: ev(1) })   // ≤ cursor → gated
        yield* bus.publish({ seq: 100, event: ev(2) })  // new → delivered
        return Array.from(yield* Fiber.join(fiber))
      })
    )
    expect(out.map((se) => se.seq)).toEqual([100])
  })

  it("appends racing the backlog drain are delivered exactly once, in order, under every interleaving", async () => {
    const out = await run(
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
        // The two genuinely-new events are committed the way the server does
        // (append → publish each) but only AFTER a 50ms sleep. Subscription is the
        // handler's first effect, triggered by the fork's first pull (microsecond
        // latency); 50ms is orders of magnitude above that, so these NEW events are
        // guaranteed to land after the subscription and therefore be delivered —
        // without that guarantee take(5) could hang. The sleep is honestly here for
        // the NEW events only; the DUPLICATE above is published sleep-free precisely
        // so it can race the drain.
        yield* Effect.sleep(50)
        const s4 = yield* events.append(ev(4))
        yield* bus.publish({ seq: s4, event: ev(4) })
        const s5 = yield* events.append(ev(5))
        yield* bus.publish({ seq: s5, event: ev(5) })
        return Array.from(yield* Fiber.join(fiber))
      })
    )
    expect(out.map((se) => se.seq)).toEqual([1, 2, 3, 4, 5])
  })
})
