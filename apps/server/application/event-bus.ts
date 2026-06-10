import { Context, Effect, Layer, PubSub, Scope, Stream } from "effect"
import type { SequencedEvent } from "@yodea/contracts/events/domain"

export class EventBus extends Context.Service<EventBus, {
  readonly publish: (event: SequencedEvent) => Effect.Effect<boolean>
  readonly subscribe: Effect.Effect<PubSub.Subscription<SequencedEvent>, never, Scope.Scope>
  readonly stream: Stream.Stream<SequencedEvent>
}>()("yodea/EventBus", {
  make: Effect.gen(function*() {
    const pubsub = yield* PubSub.unbounded<SequencedEvent>()
    return {
      publish: (event: SequencedEvent) => PubSub.publish(pubsub, event),
      subscribe: PubSub.subscribe(pubsub),
      stream: Stream.fromPubSub(pubsub)
    } as const
  })
}) { }

export const EventBusLayer = Layer.effect(EventBus, EventBus.make)
