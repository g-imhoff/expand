import { Context, Deferred, Effect, Layer, Ref } from "effect"

/**
 * The I-4 state machine: the instant the live-connection count returns to
 * zero, shutdown fires.
 *
 * @remarks
 * "Armed" by the first-ever connect, so a freshly booted server with no
 * clients yet does not shut down. Each transition is one atomic `Ref.modify`
 * step — the fire decision is computed with the decrement, so a connect
 * interleaved between them cannot race a stale zero. Fires exactly once.
 */
export class ConnectionTracker extends Context.Service<ConnectionTracker, {
  /** Counts a connection in and arms the tracker. */
  readonly onConnect: Effect.Effect<void>
  /** Counts a connection out (floored at zero); fires shutdown at armed zero. */
  readonly onDisconnect: Effect.Effect<void>
  /** Resolves once, when I-4 triggers — the server's lifetime await. */
  readonly awaitShutdown: Effect.Effect<void>
  /** Observability (used by tests): whether shutdown has fired. */
  readonly isShuttingDown: Effect.Effect<boolean>
  /** Observability (used by tests): the current live-connection count. */
  readonly count: Effect.Effect<number>
}>()("yodea/ConnectionTracker", {
  make: Effect.gen(function* () {
    const state = yield* Ref.make({ count: 0, armed: false })
    const shutdown = yield* Deferred.make<void>()

    const onConnect = Ref.update(state, (s) => ({ count: s.count + 1, armed: true }))

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
