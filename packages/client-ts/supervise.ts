import { Cause, Effect, Exit } from "effect"

/**
 * Wrap a background fiber so a non-interrupt crash is logged (with its cause)
 * rather than dropped silently.
 *
 * @internal
 */
export const supervised = Effect.fn("Client.supervised")(<A, E, R>(
  label: string,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  Effect.onExit(effect, (exit) =>
    Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
      ? Effect.logError(`[${label}] background fiber died`, exit.cause)
      : Effect.void
  )
)
