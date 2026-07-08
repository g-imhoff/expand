// S5 — RPC replay: a real WebSocket client drains the full backlog through
// Events({ fromSeq: 0 }). Queue.take per event is exactly what production
// clients pay (client-ts drains one take at a time). Budget: ≥ 20k events/s.
import { Duration, Effect, Queue } from "effect"
import { plantCheckpoint } from "../seed"
import { withRss } from "../rss"
import type { Measurement, ScenarioContext } from "../report"
import { withServer } from "./server-e2e"

export const runRpcReplay = async (ctx: ScenarioContext): Promise<ReadonlyArray<Measurement>> => {
  // keep server boot fast and out of the picture — we measure replay, not boot
  await plantCheckpoint(ctx.dbPath, 0)
  const { value, rssDeltaBytes } = await withRss(() =>
    withServer(ctx.dbPath, (client) =>
      Effect.gen(function* () {
        const queue = yield* client.Events({ fromSeq: 0 }, { asQueue: true })
        const [elapsed] = yield* Effect.timed(
          Effect.gen(function* () {
            let lastSeq = 0
            while (lastSeq < ctx.eventCount) {
              const sequenced = yield* Queue.take(queue)
              lastSeq = sequenced.seq
            }
          })
        )
        return Duration.toMillis(elapsed)
      })
    )
  )
  return [
    {
      key: "s5-rpc-replay",
      label: "S5 RPC replay drain (fromSeq 0)",
      scale: ctx.scale,
      wallMs: value.result,
      events: ctx.eventCount,
      rssDeltaBytes
    }
  ]
}
