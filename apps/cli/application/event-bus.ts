import { Context, Effect, Layer, PubSub, Scope, Stream } from "effect"
import type { DomainEvent } from "@yodea/contracts/events"

export class EventBus extends Context.Service<EventBus, {
  readonly publish: (event: DomainEvent) => Effect.Effect<boolean>
  // Scoped Subscription — deterministic consumers/tests use this.
  readonly subscribe: Effect.Effect<PubSub.Subscription<DomainEvent>, never, Scope.Scope>
  // Stream view — the RPC `Events` handler returns this (new subscription per run).
  readonly stream: Stream.Stream<DomainEvent>
}>()("yodea/EventBus", {
  // `make`: the PubSub is a resource; it is shut down when the AppLayer scope closes.
  make: Effect.gen(function* () {
    const pubsub = yield* PubSub.unbounded<DomainEvent>()
    return {
      publish: (event: DomainEvent) => PubSub.publish(pubsub, event),
      // Scoped Subscription — consume with PubSub.take.
      subscribe: PubSub.subscribe(pubsub),
      // Stream view — Stream.fromPubSub self-subscribes (new subscription per run).
      stream: Stream.fromPubSub(pubsub)
    } as const
  })
}) {}

// v4 has no auto `.Default` layer — wire it manually with Layer.effect.
export const EventBusLayer = Layer.effect(EventBus, EventBus.make)
