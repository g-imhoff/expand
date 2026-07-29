import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect, PubSub } from "effect"
import { EventBus, EventBusLayer } from "@expand/server/application/event-bus"
import { ProjectCreated } from "@expand/contracts/events/project"

const uid = (n: number): string => "00000000-0000-4000-8000-" + String(n).padStart(12, "0")

describe("EventBus", () => {
  it.live("delivers sequenced events published after a subscription",  () => Effect.gen(function*() {
    const program = Effect.gen(function* () {
      const bus = yield* EventBus
      const sub = yield* bus.subscribe
      yield* bus.publish({
        seq: 1,
        event: ProjectCreated.make({ projectId: uid(1), name: "alpha", occurredAt: "t1" })
      })
      return yield* PubSub.take(sub)
    }).pipe(Effect.scoped, Effect.provide(EventBusLayer))

    const se = yield* (program)
    expect(se.seq).toBe(1)
    expect(se.event._tag).toBe("ProjectCreated")
    expect(se.event.projectId).toBe(uid(1))
  }))
})

describe("EventBus — subscription timing", () => {
  it.live("does NOT deliver events published before a subscription attaches (live-only)",  () => Effect.gen(function*() {
    const program = Effect.gen(function* () {
      const bus = yield* EventBus
      yield* bus.publish({ seq: 1, event: ProjectCreated.make({ projectId: uid(1), name: "early", occurredAt: "t0" }) })
      const sub = yield* bus.subscribe
      yield* bus.publish({ seq: 2, event: ProjectCreated.make({ projectId: uid(2), name: "late", occurredAt: "t1" }) })
      return yield* PubSub.take(sub)
    }).pipe(Effect.scoped, Effect.provide(EventBusLayer))
    const se = yield* (program)
    expect(se.event.projectId).toBe(uid(2))
  }))

  it.live("fans one publish out to two independent subscribers",  () => Effect.gen(function*() {
    const program = Effect.gen(function* () {
      const bus = yield* EventBus
      const subA = yield* bus.subscribe
      const subB = yield* bus.subscribe
      yield* bus.publish({ seq: 1, event: ProjectCreated.make({ projectId: uid(1), name: "alpha", occurredAt: "t1" }) })
      const a = yield* PubSub.take(subA)
      const b = yield* PubSub.take(subB)
      return { a, b }
    }).pipe(Effect.scoped, Effect.provide(EventBusLayer))
    const { a, b } = yield* (program)
    expect(a.event.projectId).toBe(uid(1))
    expect(b.event.projectId).toBe(uid(1))
  }))

  it.live("dropping one subscriber mid-stream does not block delivery to the survivor",  () => Effect.gen(function*() {
    const program = Effect.gen(function* () {
      const bus = yield* EventBus
      const survivor = yield* bus.subscribe
      yield* Effect.scoped(
        Effect.gen(function* () {
          const transient = yield* bus.subscribe
          yield* bus.publish({ seq: 1, event: ProjectCreated.make({ projectId: uid(1), name: "alpha", occurredAt: "t1" }) })
          const first = yield* PubSub.take(transient)
          expect(first.event.projectId).toBe(uid(1))
        })
      )
      yield* bus.publish({ seq: 2, event: ProjectCreated.make({ projectId: uid(2), name: "beta", occurredAt: "t2" }) })
      const a1 = yield* PubSub.take(survivor)
      const a2 = yield* PubSub.take(survivor)
      return [a1.event.projectId, a2.event.projectId]
    }).pipe(Effect.scoped, Effect.provide(EventBusLayer))
    const got = yield* (program)
    expect(got).toEqual([uid(1), uid(2)])
  }))
})
