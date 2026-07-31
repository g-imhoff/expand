import { Cause, Effect, Exit } from "effect"

export const supervised = Effect.fn("DesktopRenderer.supervised")(<A, E, R>(
  label: string,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  Effect.onExit(effect, (exit) =>
    Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
      ? Effect.logError(`[${label}] background fiber died`, exit.cause)
      : Effect.void
  )
)
