import { Context, Effect, Layer, PubSub, Scope, Stream } from "effect"
import type { DomainEvent } from "@yodea/contracts/events/domain"

export class EventBus extends Context.Service<EventBus, {
  readonly publish: (event: DomainEvent) => Effect.Effect<boolean>
  readonly subscribe: Effect.Effect<PubSub.Subscription<DomainEvent>, never, Scope.Scope>
  readonly stream: Stream.Stream<DomainEvent>
}>()("yodea/EventBus", {
  make: Effect.gen(function*() {
    const pubsub = yield* PubSub.unbounded<DomainEvent>()
    return {
      publish: (event: DomainEvent) => PubSub.publish(pubsub, event),
      subscribe: PubSub.subscribe(pubsub),
      stream: Stream.fromPubSub(pubsub)
    } as const
  })
}) { }

export const EventBusLayer = Layer.effect(EventBus, EventBus.make)
