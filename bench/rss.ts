// Measurement helpers: RSS sampling and timed layer builds.
import { Duration, Effect, Exit, Layer, Scope } from "effect"

export interface Sampled<A> {
  readonly value: A
  readonly rssDeltaBytes: number
}

// Interval RSS sampler: GC + baseline before, peak during (~50ms period), final
// sample after. ΔRSS is a boundedness proxy — it must NOT grow with event count.
export const withRss = async <A>(run: () => Promise<A>): Promise<Sampled<A>> => {
  Bun.gc(true)
  const baseline = process.memoryUsage().rss
  let peak = baseline
  const timer = setInterval(() => {
    const rss = process.memoryUsage().rss
    if (rss > peak) peak = rss
  }, 50)
  try {
    const value = await run()
    const final = process.memoryUsage().rss
    if (final > peak) peak = final
    return { value, rssDeltaBytes: Math.max(0, peak - baseline) }
  } finally {
    clearInterval(timer)
  }
}

// Time ONLY the layer build (the boot fold happens inside it); the scope close —
// which writes the projection's final checkpoint — is deliberately outside the clock.
export const timedLayerBuild = <ROut, E>(layer: Layer.Layer<ROut, E>): Effect.Effect<number, E> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    const [elapsed] = yield* Effect.timed(Layer.buildWithScope(layer, scope))
    yield* Scope.close(scope, Exit.void)
    return Duration.toMillis(elapsed)
  })
