import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { ConnectionTracker, ConnectionTrackerLayer } from "@yodea/server/connection-tracker"

const run = <A, E>(eff: Effect.Effect<A, E, ConnectionTracker>) =>
  Effect.runPromise(Effect.provide(Effect.scoped(eff), ConnectionTrackerLayer))

describe("ConnectionTracker (I-4)", () => {
  it("is not armed before the first connect, and arms then fires exactly at zero", async () => {
    const states = await run(
      Effect.gen(function* () {
        const t = yield* ConnectionTracker
        const s0 = yield* t.isShuttingDown // false: nothing happened
        yield* t.onDisconnect // disconnect before any connect: not armed
        const s1 = yield* t.isShuttingDown // false: still not armed
        yield* t.onConnect // count 0->1, ARMED
        yield* t.onConnect // count 1->2
        yield* t.onDisconnect // count 2->1
        const s2 = yield* t.isShuttingDown // false: one still connected
        yield* t.onDisconnect // count 1->0, armed -> FIRE
        const s3 = yield* t.isShuttingDown // true
        return { s0, s1, s2, s3 }
      })
    )
    expect(states).toEqual({ s0: false, s1: false, s2: false, s3: true })
  })

  it("never lets the count go negative", async () => {
    const n = await run(
      Effect.gen(function* () {
        const t = yield* ConnectionTracker
        yield* t.onDisconnect
        yield* t.onDisconnect
        return yield* t.count
      })
    )
    expect(n).toBe(0)
  })
})
