import { describe, expect, it } from "vitest"
import { Effect, PubSub } from "effect"
import { EventBus, EventBusLayer } from "@yodea/application/event-bus"
import { SessionCreated } from "@yodea/shared/events"

describe("EventBus", () => {
  it("delivers events published after a subscription", async () => {
    const program = Effect.gen(function* () {
      const bus = yield* EventBus
      // Subscribe BEFORE publishing — PubSub only delivers to live subscribers.
      const sub = yield* bus.subscribe
      yield* bus.publish(
        SessionCreated.make({ sessionId: "s1", title: "A", createdAt: "t1" })
      )
      return yield* PubSub.take(sub)
    }).pipe(Effect.scoped, Effect.provide(EventBusLayer))

    const event = await Effect.runPromise(program)
    expect(event._tag).toBe("SessionCreated")
    expect(event.sessionId).toBe("s1")
  })
})
