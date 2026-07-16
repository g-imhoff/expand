import { Effect, Exit, FiberSet } from "effect"

export interface RendererRunner {
  readonly start: <A, E>(
    effect: Effect.Effect<A, E>,
    onExit: (exit: Exit.Exit<A, E>) => void
  ) => RendererCancel
}

export interface RendererRunnerOwner {
  readonly runner: RendererRunner
  readonly failure: Effect.Effect<never>
}

export type RendererCancel = () => void

export const makeRendererRunner = Effect.fn("DesktopRenderer.makeRendererRunner")(function* () {
  const fibers = yield* FiberSet.make<unknown, never>()
  const runFork = yield* FiberSet.runtime(fibers)<never>()
  const runner: RendererRunner = {
    start: <A, E>(effect: Effect.Effect<A, E>, onExit: (exit: Exit.Exit<A, E>) => void) => {
      const fiber = runFork(
        Effect.exit(effect).pipe(
          Effect.onExit((outerExit) =>
            Effect.sync(() => {
              onExit(
                Exit.isSuccess(outerExit)
                  ? outerExit.value
                  : Exit.failCause(outerExit.cause)
              )
            }))
        )
      )
      let cancelled = false
      return () => {
        if (cancelled) return
        cancelled = true
        fiber.interruptUnsafe()
      }
    }
  }
  return {
    runner,
    failure: FiberSet.join(fibers).pipe(Effect.andThen(Effect.never))
  }
})

export const startRendererRoot = <A, E>(
  effect: Effect.Effect<A, E>,
  onExit: (exit: Exit.Exit<A, E>) => void
): RendererCancel => {
  const fiber = Effect.runFork(effect)
  try {
    fiber.addObserver(onExit)
  } catch (error) {
    try {
      fiber.interruptUnsafe()
    } catch (interruptError) {
      throw new AggregateError([error, interruptError], "renderer root startup failed")
    }
    throw error
  }
  let cancelled = false
  return () => {
    if (cancelled) return
    cancelled = true
    fiber.interruptUnsafe()
  }
}
