// Measurement helpers: RSS sampling and timed layer builds.
import { Context, Data, Duration, Effect, Exit, Fiber, Layer, Ref, Scope } from "effect"

interface Sampled<A> {
  readonly value: A
  readonly rssDeltaBytes: number
}

export interface MachineInfo {
  readonly cpu: string
  readonly cores: number
  readonly nodeVersion: string
  readonly platform: string
  readonly arch: string
  readonly totalMemGb: number
}

export class BenchmarkGcUnavailable extends Data.TaggedError("BenchmarkGcUnavailable")<{}> {}

export interface BenchmarkHostShape {
  readonly rss: Effect.Effect<number>
  readonly gc: Effect.Effect<void, BenchmarkGcUnavailable>
  readonly machineInfo: Effect.Effect<MachineInfo>
}

export class BenchmarkHost extends Context.Service<BenchmarkHost, BenchmarkHostShape>()(
  "expand/BenchmarkHost"
) {}

export const makeBenchmarkHostLayer = (adapter: {
  readonly rss: () => number
  readonly gc?: (() => void) | undefined
  readonly machineInfo: () => MachineInfo
}) => Layer.succeed(BenchmarkHost, BenchmarkHost.of({
  rss: Effect.sync(adapter.rss),
  gc: adapter.gc === undefined
    ? Effect.fail(new BenchmarkGcUnavailable())
    : Effect.sync(adapter.gc),
  machineInfo: Effect.sync(adapter.machineInfo)
}))

// Interval RSS sampler: GC + baseline before, peak during (~50ms period), final
// sample after. ΔRSS is a boundedness proxy — it must NOT grow with event count.
export const withRss = Effect.fn("Benchmark.withRss")(function*<A, E, R>(run: Effect.Effect<A, E, R>) {
  const host = yield* BenchmarkHost
  yield* host.gc.pipe(Effect.catchTag("BenchmarkGcUnavailable", () => Effect.void))
  const baseline = yield* host.rss
  const peak = yield* Ref.make(baseline)
  const sample = host.rss.pipe(Effect.flatMap((rss) => Ref.update(peak, (current) => Math.max(current, rss))))
  const sampler = Effect.forever(Effect.sleep("50 millis").pipe(Effect.andThen(sample)))
  yield* Effect.acquireRelease(Effect.forkDetach(sampler), Fiber.interrupt)
  const value = yield* run
  yield* sample
  const maximum = yield* Ref.get(peak)
  return { value, rssDeltaBytes: Math.max(0, maximum - baseline) }
})

// Time ONLY the layer build (the boot fold happens inside it); the success-path
// scope close — which writes the projection's final checkpoint — is deliberately
// outside the clock. On build failure the scope is closed (finalizers fire) before
// the error propagates, so a half-built layer can never leak resources.
export const timedLayerBuild = Effect.fn("Benchmark.timedLayerBuild")(<ROut, E>(layer: Layer.Layer<ROut, E>) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    const [elapsed] = yield* Effect.timed(Layer.buildWithScope(layer, scope)).pipe(
      Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause)))
    )
    yield* Scope.close(scope, Exit.void)
    return Duration.toMillis(elapsed)
  }))
