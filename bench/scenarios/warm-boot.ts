// S2 — warm boot: checkpoint planted at maxSeq - T, boot folds only the tail.
// This is the O(tail) claim, measured. Budgets: t0/t1k ≤ 150ms at every scale.
import { Effect } from "effect"
import { plantCheckpoint } from "../seed"
import { timedLayerBuild, withRss } from "../rss"
import type { Measurement, ScenarioContext } from "../report"
import { projectionBootLayer } from "./cold-boot"

const TAILS = [
  { suffix: "t0", tail: 0 },
  { suffix: "t1k", tail: 1_000 },
  { suffix: "t10k", tail: 10_000 }
] as const

export const runWarmBoot = Effect.fn("Benchmark.runWarmBoot")((ctx: ScenarioContext) =>
  Effect.forEach(TAILS, ({ suffix, tail }) => {
    if (tail >= ctx.eventCount) return Effect.void // smoke scale: only t0 is meaningful
    return Effect.gen(function*() {
      yield* plantCheckpoint(ctx.dbPath, tail) // untimed setup, correct-by-construction
      const { value: wallMs, rssDeltaBytes } = yield* withRss(
        timedLayerBuild(projectionBootLayer(ctx.dbPath))
      )
      return {
        key: `s2-warm-boot-${suffix}`,
        label: `S2 warm boot (tail ${tail.toLocaleString()})`,
        scale: ctx.scale,
        wallMs,
        events: tail,
        rssDeltaBytes
      } satisfies Measurement
    })
  }, { concurrency: 1 }).pipe(
    Effect.map((measurements) => measurements.flatMap((measurement) => measurement === undefined ? [] : [measurement]) as ReadonlyArray<Measurement>)
  ))
