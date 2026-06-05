import { Context, Deferred, Effect, Layer, Ref } from "effect"

export class ConnectionTracker extends Context.Service<ConnectionTracker, {
  readonly onConnect: Effect.Effect<void>
  readonly onDisconnect: Effect.Effect<void>
  readonly awaitShutdown: Effect.Effect<void>
  readonly isShuttingDown: Effect.Effect<boolean>
  readonly count: Effect.Effect<number>
}>()("yodea/ConnectionTracker", {
  make: Effect.gen(function* () {
    const count = yield* Ref.make(0)
    const armed = yield* Ref.make(false)
    const shutdown = yield* Deferred.make<void>()

    const onConnect = Effect.andThen(
      Ref.update(count, (n) => n + 1),
      Ref.set(armed, true)
    )

    const onDisconnect = Effect.gen(function* () {
      const n = yield* Ref.updateAndGet(count, (c) => Math.max(0, c - 1))
      const isArmed = yield* Ref.get(armed)
      if (isArmed && n === 0) {
        yield* Deferred.succeed(shutdown, undefined)
      }
    })

    return {
      onConnect,
      onDisconnect,
      awaitShutdown: Deferred.await(shutdown),
      isShuttingDown: Deferred.isDone(shutdown),
      count: Ref.get(count)
    } as const
  })
}) {}

export const ConnectionTrackerLayer = Layer.effect(ConnectionTracker, ConnectionTracker.make)
