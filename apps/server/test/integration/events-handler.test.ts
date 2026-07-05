import { describe, expect, it } from "vitest"
import { Effect, Fiber, Layer, Stream } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EventStore, EventStoreLayer } from "@yodea/server/db/event-store"
import { EventBus, EventBusLayer } from "@yodea/server/application/event-bus"
import { streamHandlers } from "@yodea/server/rpc/stream"
import { ProjectCreated } from "@yodea/contracts/events/project"

const uid = (n: number): string => "00000000-0000-4000-8000-" + String(n).padStart(12, "0")
const ev = (n: number) => ProjectCreated.make({ projectId: uid(n), name: `p${n}`, occurredAt: `t${n}` })

const TestLayer = Layer.mergeAll(EventStoreLayer, EventBusLayer).pipe(
  Layer.provideMerge(SqliteClient.layer({ filename: ":memory:", disableWAL: true }))
)

const run = <A, E>(eff: Effect.Effect<A, E, EventStore | EventBus>) =>
  Effect.runPromise(Effect.provide(Effect.scoped(eff), TestLayer))

describe("Events handler — streamed backlog + live dedup gate", () => {
  it("replays the backlog then filters live events at or below the replay boundary", async () => {
    const out = await run(
      Effect.gen(function* () {
        const store = yield* EventStore
        const bus = yield* EventBus
        for (let n = 1; n <= 3; n++) yield* store.append(uid(n), ev(n))
        const stream = streamHandlers.Events({ fromSeq: 0 })
        const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(stream, 4)))
        // Give the handler time to subscribe + drain the backlog, then publish a
        // DUPLICATE of seq 3 (must be gated out) and a genuinely new seq 4.
        // Timing note: if the duplicate lands before the subscription, it is
        // simply never seen — the assertion holds either way; no flake window.
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
})
