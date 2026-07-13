// S4 — scan drain: ReplayFeed.read(0) fully consumed. Isolates SQL fetch +
// fail-fast decode throughput, no consumer work, no wire. Budget: ≥100k events/s.
import { Duration, Effect, Layer, Stream } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { EventScanChunkSize } from "@expand/server/db/event-store"
import { ReplayFeed, ReplayFeedLayer } from "@expand/server/db/replay-feed"
import { withRss } from "../rss"
import type { Measurement, ScenarioContext } from "../report"

export const runScanDrain = async (ctx: ScenarioContext): Promise<ReadonlyArray<Measurement>> => {
  const sql = SqliteClient.layer({ filename: ctx.dbPath })
  const base = ReplayFeedLayer.pipe(Layer.provide(sql))
  const layer = ctx.chunkSize === undefined ? base : base.pipe(Layer.provide(Layer.succeed(EventScanChunkSize, ctx.chunkSize)))
  const program = Effect.gen(function* () {
    const feed = yield* ReplayFeed
    const [elapsed, count] = yield* Effect.timed(Stream.runFold(feed.read(0), () => 0, (n) => n + 1))
    return { wallMs: Duration.toMillis(elapsed), count }
  })
  const { value, rssDeltaBytes } = await withRss(() => Effect.runPromise(Effect.provide(program, layer)))
  if (value.count !== ctx.eventCount) {
    throw new Error(`scan drained ${value.count} events, expected ${ctx.eventCount}`)
  }
  return [
    {
      key: "s4-scan-drain",
      label: "S4 scan drain (ReplayFeed.read(0))",
      scale: ctx.scale,
      wallMs: value.wallMs,
      events: value.count,
      rssDeltaBytes
    }
  ]
}
