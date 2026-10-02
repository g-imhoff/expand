import { Context, Deferred, Effect, Layer, Queue, Ref, Scope, Stream } from "effect"
import type { SequencedEvent } from "@expand/contracts/events/domain"
import { EventsLagged } from "@expand/contracts/rpc/stream"

export interface EventSubscription {
  readonly take: Effect.Effect<SequencedEvent, EventsLagged>
  readonly pending: Effect.Effect<number>
}

export class EventBus extends Context.Service<EventBus, {
  /**
   * Offers one event to every current subscriber without waiting for slow
   * consumers; a subscriber whose buffer is full is evicted instead of
   * blocking. Resolves `true` once the offer pass completes.
   */
  readonly publish: (event: SequencedEvent) => Effect.Effect<boolean>
  /**
   * Scoped subscription that buffers from THIS moment — the replay seam
   * subscribes first, then reads the backlog, so nothing in between is lost.
   * The buffer holds at most `lagCapacity` events; overflow evicts the
   * subscription and `take` fails with `EventsLagged`.
   */
  readonly subscribe: Effect.Effect<EventSubscription, never, Scope.Scope>
  /** Live feed; subscribes only when run — use `subscribe` when the subscription point must be explicit. */
  readonly stream: Stream.Stream<SequencedEvent, EventsLagged>
  /** How many undelivered events one subscriber may lag before eviction. */
  readonly lagCapacity: number
  /** Current live subscriber count, for monitoring that stalled consumers are freed. */
  readonly subscriberCount: Effect.Effect<number>
}>()("expand/EventBus", {
  make: Effect.suspend(() => makeBus(DEFAULT_EVENT_BUS_LAG_CAPACITY))
}) {}

/**
 * Per-subscriber lag capacity: how many live events a slow `Events` consumer
 * may trail behind before its subscription is terminated.
 *
 * @remarks
 * Each subscription buffers at most this many undelivered events. A client
 * that stalls longer is disconnected with `EventsLagged` instead of
 * retaining unbounded memory in the shared backend. Publication never waits
 * for a slow consumer, so one stalled client cannot block commits for
 * healthy ones. A disconnected client reconnects with
 * `fromSeq` set to its last confirmed sequence and recovers the gap from
 * persisted replay. 256 sequenced project events are small (tens of KB),
 * while normal consumers trail by zero.
 */
export const DEFAULT_EVENT_BUS_LAG_CAPACITY = 256

export const EventBusLayer = Layer.effect(EventBus, EventBus.make)

export const makeEventBusLayer = (lagCapacity: number) => Layer.effect(EventBus, makeBus(lagCapacity))

interface SubscriberState {
  readonly queue: Queue.Queue<SequencedEvent>
  readonly lagged: Deferred.Deferred<EventsLagged>
}

const makeBus = (lagCapacity: number) =>
  Effect.gen(function* () {
    const capacity = Math.max(1, Math.floor(lagCapacity))
    const subscribers = yield* Ref.make(new Map<number, SubscriberState>())
    const nextId = yield* Ref.make(0)

    const evict = (id: number, state: SubscriberState) =>
      Ref.update(subscribers, (current) => {
        const next = new Map(current)
        next.delete(id)
        return next
      }).pipe(
        Effect.andThen(Deferred.succeed(state.lagged, new EventsLagged({ lagCapacity: capacity }))),
        Effect.asVoid
      )

    const publish = (event: SequencedEvent): Effect.Effect<boolean> =>
      Effect.suspend(() => {
        const snapshot = Ref.get(subscribers)
        return Effect.flatMap(snapshot, (current) => {
          if (current.size === 0) return Effect.succeed(true)
          const evictions: Array<Effect.Effect<void>> = []
          for (const [id, state] of current) {
            if (!Queue.offerUnsafe(state.queue, event)) evictions.push(evict(id, state))
          }
          return Effect.as(Effect.all(evictions, { discard: true }), true)
        })
      })

    const take = (state: SubscriberState): Effect.Effect<SequencedEvent, EventsLagged> =>
      Effect.raceFirst(
        Queue.take(state.queue),
        Effect.flatMap(Deferred.await(state.lagged), (cause) => Effect.fail(cause))
      )

    const subscribe: Effect.Effect<EventSubscription, never, Scope.Scope> = Effect.gen(function* () {
      const queue = yield* Queue.bounded<SequencedEvent>(capacity)
      const lagged = yield* Deferred.make<EventsLagged>()
      const state: SubscriberState = { queue, lagged }
      const id = yield* Ref.updateAndGet(nextId, (n) => n + 1)
      yield* Ref.update(subscribers, (current) => new Map(current).set(id, state))
      yield* Effect.addFinalizer(() =>
        Ref.update(subscribers, (current) => {
          const next = new Map(current)
          next.delete(id)
          return next
        }).pipe(Effect.andThen(Queue.shutdown(queue)))
      )
      return { take: take(state), pending: Queue.size(queue) }
    })

    return {
      publish,
      subscribe,
      stream: Stream.unwrap(Effect.map(subscribe, (sub) => Stream.fromEffectRepeat(sub.take))),
      lagCapacity: capacity,
      subscriberCount: Ref.get(subscribers).pipe(Effect.map((current) => current.size))
    } as const
  })
