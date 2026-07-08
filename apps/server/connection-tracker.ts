import { Context, Deferred, Effect, Layer, Ref } from "effect"

export class ConnectionTracker extends Context.Service<ConnectionTracker, {
  readonly onConnect: Effect.Effect<void>
  readonly onDisconnect: Effect.Effect<void>
  readonly awaitShutdown: Effect.Effect<void>
  readonly isShuttingDown: Effect.Effect<boolean>
  readonly count: Effect.Effect<number>
}>()("yodea/ConnectionTracker", {
  make: Effect.gen(function* () {
    const state = yield* Ref.make({ count: 0, armed: false })
    const shutdown = yield* Deferred.make<void>()

    const onConnect = Ref.update(state, (s) => ({ count: s.count + 1, armed: true }))

    // The fire decision is computed in the SAME atomic step as the decrement, so
    // a connect interleaved between them can never race a stale zero.
    const onDisconnect = Ref.modify(state, (s) => {
      const count = Math.max(0, s.count - 1)
      return [s.armed && count === 0, { ...s, count }] as const
    }).pipe(Effect.flatMap((fire) => (fire ? Effect.asVoid(Deferred.succeed(shutdown, undefined)) : Effect.void)))

    return {
      onConnect,
      onDisconnect,
      awaitShutdown: Deferred.await(shutdown),
      isShuttingDown: Deferred.isDone(shutdown),
      count: Effect.map(Ref.get(state), (s) => s.count)
    } as const
  })
}) {}

export const ConnectionTrackerLayer = Layer.effect(ConnectionTracker, ConnectionTracker.make)
