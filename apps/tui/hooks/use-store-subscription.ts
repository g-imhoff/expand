import { useContext, useEffect, useState } from "react"
import { Cause, Effect, Exit, Stream, SubscriptionRef } from "effect"
import type { ProjectStore } from "@yodea/client-core"
import { RuntimeContext } from "@yodea/tui/runtime"

export type SubscriptionStatus = "loading" | "ready" | "error"

export interface Subscription<A> {
  readonly value: A
  readonly status: SubscriptionStatus
  readonly error?: string
}

// Drive any reactive ref selected from the store into React state for the
// component's lifetime. `selectRef` MUST be a stable reference (a module-level
// constant or memoized) — it is intentionally excluded from the effect deps.
export const useStoreSubscription = <A>(
  selectRef: Effect.Effect<SubscriptionRef.SubscriptionRef<A>, never, ProjectStore>,
  initial: A,
): Subscription<A> => {
  const runtime = useContext(RuntimeContext)
  if (!runtime) throw new Error("useStoreSubscription must be used within a RuntimeContext")
  const [state, setState] = useState<Subscription<A>>({ value: initial, status: "loading" })

  useEffect(() => {
    let mounted = true
    const cancel = runtime.runCallback(
      Effect.flatMap(selectRef, (ref) =>
        Stream.runForEach(SubscriptionRef.changes(ref), (v) =>
          Effect.sync(() => {
            if (mounted) setState({ value: v, status: "ready" })
          })
        )
      ),
      {
        onExit: (exit) => {
          // The only non-interrupt exit is a store-build failure (defect). On
          // unmount we set mounted=false before cancelling, so the interrupt
          // exit is ignored here.
          if (!mounted) return
          if (Exit.isFailure(exit)) {
            setState((prev) => ({ value: prev.value, status: "error", error: Cause.pretty(exit.cause) }))
          }
        },
      }
    )
    return () => {
      mounted = false
      cancel()
    }
  }, [runtime])

  return state
}
