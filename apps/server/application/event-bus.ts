import { Context, Effect, Layer, PubSub, Scope, Stream } from "effect"
import type { SequencedEvent } from "@expand/contracts/events/domain"

/**
 * In-process broadcast of freshly committed events — the live half of the
 * `Events` stream (`ReplayFeed` is the persisted half).
 *
 * @remarks
 * Published by the single committer after append + apply, so bus reactions
 * always observe the updated read model. Unbounded on purpose (publish never
 * blocks); no history — catch-up is `ReplayFeed`'s job.
 */
export class EventBus extends Context.Service<EventBus, {
  /** Broadcasts to every current subscriber; `false` only after shutdown. */
  readonly publish: (event: SequencedEvent) => Effect.Effect<boolean>
  /**
   * Scoped subscription that buffers from THIS moment — the replay seam
   * subscribes first, then reads the backlog, so nothing in between is lost.
   */
  readonly subscribe: Effect.Effect<PubSub.Subscription<SequencedEvent>, never, Scope.Scope>
  /** Live feed; subscribes only when run — use `subscribe` when the subscription point must be explicit. */
  readonly stream: Stream.Stream<SequencedEvent>
}>()("expand/EventBus", {
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
