import { useEffect, useMemo } from "react"
import { Cause, Effect, Exit, Fiber, ManagedRuntime } from "effect"
import type { ClientSession } from "@expand/client-ts"
import type { ProjectClient } from "@expand/client-ts/project"
import type { ServerClient } from "@expand/client-ts/server"
import type { ExpandRuntimeError } from "@expand/tui/runtime/tui-runtime"

export interface TuiEffectRunner {
  readonly start: <A, E>(
    effect: Effect.Effect<A, E, TuiRequirements>,
    onExit: (exit: Exit.Exit<A, E | ExpandRuntimeError>) => void
  ) => () => void
  readonly dispose: () => void
}

export type TuiRequirements = ClientSession | ProjectClient | ServerClient

export const makeEffectRunner = (
  runtime: ManagedRuntime.ManagedRuntime<TuiRequirements, ExpandRuntimeError>
): TuiEffectRunner => {
  let active = true
  const cancellations = new Set<() => void>()
  const { runFork } = runtime
  const fork = <A, E>(effect: Effect.Effect<A, E, TuiRequirements>) => runFork(effect)
  const observe = <A, E>(
    effect: Effect.Effect<A, E, TuiRequirements>,
    onExit: (exit: Exit.Exit<A, E | ExpandRuntimeError>) => void
  ) => {
    const fiber = fork(effect)
    fiber.addObserver(onExit)
    return fiber
  }

  const start: TuiEffectRunner["start"] = (effect, onExit) => {
    if (!active) return () => {}
    let cancelled = false
    let completed = false
    let cancel = () => {}
    const fiber = observe(
      Effect.onExit(effect, (exit) =>
        cancelled && Exit.isFailure(exit) && Cause.hasDies(exit.cause)
          ? Effect.logError("[TUI] cancelled effect died", exit.cause)
          : Effect.void
      ),
      (exit) => {
        completed = true
        cancellations.delete(cancel)
        if (active && !cancelled) onExit(exit)
      }
    )
    cancel = () => {
      if (cancelled) return
      cancelled = true
      cancellations.delete(cancel)
      observe(Fiber.interrupt(fiber), () => {})
    }
    if (!completed) cancellations.add(cancel)
    return cancel
  }

  return {
    start,
    dispose: () => {
      if (!active) return
      active = false
      for (const cancel of [...cancellations]) cancel()
    }
  }
}

export const useTuiEffectRunner = (
  runtime: ManagedRuntime.ManagedRuntime<TuiRequirements, ExpandRuntimeError>
): TuiEffectRunner => {
  const runner = useMemo(() => makeEffectRunner(runtime), [runtime])
  useEffect(() => () => runner.dispose(), [runner])
  return runner
}

export const reportFailure = (
  exit: Exit.Exit<unknown, unknown>,
  onFailure: (cause: unknown) => void
): void => {
  if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
    onFailure(Cause.squash(exit.cause))
  }
}
