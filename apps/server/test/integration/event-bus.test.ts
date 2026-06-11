import { describe, expect, it } from "vitest"
import { Effect, PubSub } from "effect"
import { EventBus, EventBusLayer } from "@yodea/server/application/event-bus"
import { ProjectCreated } from "@yodea/contracts/events/project"

describe("EventBus", () => {
  it("delivers sequenced events published after a subscription", async () => {
    const program = Effect.gen(function* () {
      const bus = yield* EventBus
      const sub = yield* bus.subscribe
      yield* bus.publish({
        seq: 1,
        event: ProjectCreated.make({ projectId: "p1", name: "A", occurredAt: "t1" })
      })
      return yield* PubSub.take(sub)
    }).pipe(Effect.scoped, Effect.provide(EventBusLayer))

    const se = await Effect.runPromise(program)
    expect(se.seq).toBe(1)
    expect(se.event._tag).toBe("ProjectCreated")
    expect(se.event.projectId).toBe("p1")
  })
})

describe("EventBus — subscription timing", () => {
  it("does NOT deliver events published before a subscription attaches (live-only)", async () => {
    const program = Effect.gen(function* () {
      const bus = yield* EventBus
      yield* bus.publish({ seq: 1, event: ProjectCreated.make({ projectId: "early", name: "early", occurredAt: "t0" }) })
      const sub = yield* bus.subscribe
      yield* bus.publish({ seq: 2, event: ProjectCreated.make({ projectId: "late", name: "late", occurredAt: "t1" }) })
      return yield* PubSub.take(sub)
    }).pipe(Effect.scoped, Effect.provide(EventBusLayer))
    const se = await Effect.runPromise(program)
    expect(se.event.projectId).toBe("late")
  })

  it("fans one publish out to two independent subscribers", async () => {
    const program = Effect.gen(function* () {
      const bus = yield* EventBus
      const subA = yield* bus.subscribe
      const subB = yield* bus.subscribe
      yield* bus.publish({ seq: 1, event: ProjectCreated.make({ projectId: "p1", name: "x", occurredAt: "t1" }) })
      const a = yield* PubSub.take(subA)
      const b = yield* PubSub.take(subB)
      return { a, b }
    }).pipe(Effect.scoped, Effect.provide(EventBusLayer))
    const { a, b } = await Effect.runPromise(program)
    expect(a.event.projectId).toBe("p1")
    expect(b.event.projectId).toBe("p1")
  })

  it("dropping one subscriber mid-stream does not block delivery to the survivor", async () => {
    const program = Effect.gen(function* () {
      const bus = yield* EventBus
      const survivor = yield* bus.subscribe
      yield* Effect.scoped(
        Effect.gen(function* () {
          const transient = yield* bus.subscribe
          yield* bus.publish({ seq: 1, event: ProjectCreated.make({ projectId: "p1", name: "x", occurredAt: "t1" }) })
          const first = yield* PubSub.take(transient)
          expect(first.event.projectId).toBe("p1")
        })
      )
      yield* bus.publish({ seq: 2, event: ProjectCreated.make({ projectId: "p2", name: "y", occurredAt: "t2" }) })
      const a1 = yield* PubSub.take(survivor)
      const a2 = yield* PubSub.take(survivor)
      return [a1.event.projectId, a2.event.projectId]
    }).pipe(Effect.scoped, Effect.provide(EventBusLayer))
    const got = await Effect.runPromise(program)
    expect(got).toEqual(["p1", "p2"])
  })
})
