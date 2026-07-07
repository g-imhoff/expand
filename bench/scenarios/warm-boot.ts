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

export const runWarmBoot = async (ctx: ScenarioContext): Promise<ReadonlyArray<Measurement>> => {
  const out: Array<Measurement> = []
  for (const { suffix, tail } of TAILS) {
    if (tail >= ctx.eventCount) continue // smoke scale: only t0 is meaningful
    await plantCheckpoint(ctx.dbPath, tail) // untimed setup, correct-by-construction
    const { value: wallMs, rssDeltaBytes } = await withRss(() =>
      Effect.runPromise(timedLayerBuild(projectionBootLayer(ctx.dbPath)))
    )
    out.push({
      key: `s2-warm-boot-${suffix}`,
      label: `S2 warm boot (tail ${tail.toLocaleString()})`,
      scale: ctx.scale,
      wallMs,
      events: tail,
      rssDeltaBytes
    })
  }
  return out
}
