import { Cause, Effect, Exit } from "effect"

/**
 * Wrap a background fiber so a non-interrupt crash is logged (with its cause)
 * rather than dropped silently. Used internally by the reactive store; not part
 * of the public barrel.
 *
 * @internal
 */
export const supervised = <A, E, R>(label: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.onExit(effect, (exit) =>
    Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
      ? Effect.logError(`[${label}] background fiber died`, exit.cause)
      : Effect.void
  )
