// The bench is quarantined from vitest by design (spec §3); this file is its test suite.
import { NodeRuntime } from "@effect/platform-node"
import { Console, Data, Effect, Exit, Schema } from "effect"
import { verdictFor, BUDGETS, RSS_BUDGET_BYTES } from "./budgets"
import { DomainEventFromJson } from "@expand/contracts/events/domain"
import { Project } from "@expand/contracts/project"
import { generateEvents, LIVE_PROJECT_CAP, ProjectsFromJson, SCALES } from "./seed"
import { eventsPerSec, hasBlocker, renderReport, toJsonReport } from "./report"
import type { Measurement, ReportMetadata } from "./report"

class BenchmarkSelfcheckError extends Data.TaggedError("BenchmarkSelfcheckError")<{
  readonly detail: string
}> {}

const JsonValue = Schema.fromJsonString(Schema.Unknown)
const encode = Schema.encodeSync(JsonValue)
const equal = (actual: unknown, expected: unknown, detail: string) =>
  encode(actual) === encode(expected)
    ? Effect.void
    : Effect.fail(new BenchmarkSelfcheckError({ detail }))
const notEqual = (actual: unknown, expected: unknown, detail: string) =>
  encode(actual) !== encode(expected)
    ? Effect.void
    : Effect.fail(new BenchmarkSelfcheckError({ detail }))
const ok = (condition: boolean, detail: string) =>
  condition ? Effect.void : Effect.fail(new BenchmarkSelfcheckError({ detail }))

const takeEvents = (n: number, seed?: number) => {
  const out = []
  for (const e of generateEvents(n, seed)) out.push(e)
  return out
}

const program = Effect.gen(function*() {
  // --- budgets & verdicts ---
  yield* equal(verdictFor("s2-warm-boot-t0", 100, 0, 1_000_000), "PASS", "under ms budget → PASS")
  yield* equal(verdictFor("s2-warm-boot-t0", 200, 0, 1_000_000), "WATCH", "≤2× ms budget → WATCH")
  yield* equal(verdictFor("s2-warm-boot-t0", 400, 0, 1_000_000), "FAIL", ">2× ms budget → FAIL")
  // throughput budget: s1 wants ≥50k events/s → 100k events in 1s passes, in 4s watches, in 10s fails
  yield* equal(verdictFor("s1-cold-boot", 1_000, 100_000, 0), "PASS", "throughput above floor → PASS")
  yield* equal(verdictFor("s1-cold-boot", 4_000, 100_000, 0), "WATCH", "throughput within 2× of floor → WATCH")
  yield* equal(verdictFor("s1-cold-boot", 10_000, 100_000, 0), "FAIL", "throughput >2× under floor → FAIL")
  // RSS budget applies to every key, even unbudgeted ones
  yield* equal(verdictFor("s3-e2e-cold", 1, null, RSS_BUDGET_BYTES + 1), "WATCH", "RSS just over budget → WATCH")
  yield* equal(verdictFor("s3-e2e-cold", 1, null, RSS_BUDGET_BYTES * 3), "FAIL", "RSS >2× budget → FAIL")
  yield* equal(verdictFor("s3-e2e-cold", 999_999, null, 0), "PASS", "no ms/throughput budget → RSS alone decides")
  yield* equal(verdictFor("s1-cold-boot", 1, 1, 0, "boom"), "ERROR", "error always wins")
  yield* ok(Object.keys(BUDGETS).length === 8, "all eight scenario keys budgeted")
  // smoke policy: --smoke verifies the harness, not performance — fixed costs
  // dominate at 1k events, so ms/throughput budgets are skipped at scale "smoke".
  // RSS boundedness and errors still judge; real scales are unaffected.
  // 10s for 1k events = 100 events/s — 500× under the s1 floor:
  yield* equal(verdictFor("s1-cold-boot", 10_000, 1_000, 0, undefined, "smoke"), "PASS", "smoke: grossly under throughput floor, bounded RSS → PASS")
  yield* equal(verdictFor("s2-warm-boot-t0", 400, 0, 0, undefined, "smoke"), "PASS", "smoke: >2× over ms budget, bounded RSS → PASS")
  yield* equal(verdictFor("s1-cold-boot", 10_000, 1_000, RSS_BUDGET_BYTES + 1, undefined, "smoke"), "WATCH", "smoke: RSS just over budget still WATCHes")
  yield* equal(verdictFor("s1-cold-boot", 10_000, 1_000, RSS_BUDGET_BYTES * 3, undefined, "smoke"), "FAIL", "smoke: RSS >2× budget still FAILs")
  yield* equal(verdictFor("s1-cold-boot", 10_000, 1_000, 0, "boom", "smoke"), "ERROR", "smoke: error still wins")
  yield* equal(verdictFor("s1-cold-boot", 10_000, 1_000, 0, undefined, "100k"), "FAIL", "real scale: the same measurement still FAILs — smoke policy does not leak")

  // --- generator ---
  // determinism: same seed → byte-identical script
  yield* equal(takeEvents(500), takeEvents(500), "same seed must produce an identical event script")
  // different seed → different script
  yield* notEqual(takeEvents(500), takeEvents(500, 7), "different seed must diverge")

  // live-population cap: replaying create/delete never exceeds LIVE_PROJECT_CAP
  {
    const alive = new Set<string>()
    for (const e of generateEvents(5_000)) {
      if (e._tag === "ProjectCreated") alive.add(e.projectId)
      if (e._tag === "ProjectDeleted") alive.delete(e.projectId)
      yield* ok(alive.size <= LIVE_PROJECT_CAP, "live population exceeded the cap")
    }
    yield* ok(alive.size > 0, "population died out — generator is degenerate")
  }

  // every event round-trips the PRODUCTION payload codec (what seeding will store)
  // (encode via runSyncExit(Schema.encodeEffect(...)) — the exact API event-store.ts
  // uses; if-throw instead of assert.ok so TypeScript narrows the Exit)
  for (const e of takeEvents(2_000)) {
    const encoded = yield* Schema.encodeEffect(DomainEventFromJson)(e).pipe(Effect.exit)
    if (!Exit.isSuccess(encoded)) return yield* new BenchmarkSelfcheckError({ detail: `event failed to encode: ${e._tag}` })
    const decoded = Schema.decodeUnknownExit(DomainEventFromJson)(encoded.value)
    if (!Exit.isSuccess(decoded)) return yield* new BenchmarkSelfcheckError({ detail: `event failed to decode back: ${e._tag}` })
  }

  // the branded-type trap (global constraints): a folded Project built from generated
  // events must survive the CHECKED checkpoint decode used at boot (projections.ts:52-60)
  {
    const created = takeEvents(50).filter((e) => e._tag === "ProjectCreated")
    yield* ok(created.length > 0, "no creates in the first 50 events")
    const projects = created.map((e) => Project.fromCreated(e as never))
    const stateJson = yield* Schema.encodeEffect(ProjectsFromJson)(projects).pipe(Effect.exit)
    if (!Exit.isSuccess(stateJson)) return yield* new BenchmarkSelfcheckError({ detail: "checkpoint state failed to encode" })
    const back = Schema.decodeUnknownExit(ProjectsFromJson)(stateJson.value)
    if (!Exit.isSuccess(back)) return yield* new BenchmarkSelfcheckError({ detail: "checkpoint state failed CHECKED decode — ids/names/tags are not brand-valid" })
  }

  // scales are what the spec says
  yield* equal(SCALES, { smoke: 1_000, "100k": 100_000, "1m": 1_000_000, "10m": 10_000_000 }, "scales changed")

  // --- report ---
  const okMeasurement: Measurement = { key: "s4-scan-drain", label: "S4 scan drain", scale: "100k", wallMs: 500, events: 100_000, rssDeltaBytes: 10 * 1024 * 1024 }
  const slow: Measurement = { key: "s2-warm-boot-t0", label: "S2 warm boot (tail 0)", scale: "1m", wallMs: 400, events: 0, rssDeltaBytes: 0 }
  const dead: Measurement = { key: "s5-rpc-replay", label: "S5 RPC replay", scale: "1m", wallMs: 0, events: null, rssDeltaBytes: 0, error: "boom" }
  const metadata: ReportMetadata = {
    machine: { cpu: "selfcheck", cores: 1, nodeVersion: "test", platform: "test", arch: "test", totalMemGb: 1 },
    generatedAt: "2026-01-01T00:00:00.000Z"
  }

  yield* equal(eventsPerSec(okMeasurement), 200_000, "event rate changed")
  yield* equal(eventsPerSec(dead), null, "dead event rate changed")
  yield* equal(hasBlocker([okMeasurement]), false, "PASS-only run has no blocker")
  yield* equal(hasBlocker([okMeasurement, slow]), true, "FAIL blocks")
  yield* equal(hasBlocker([okMeasurement, dead]), true, "ERROR blocks")

  const rendered = renderReport([okMeasurement, slow, dead], 1000, metadata.machine)
  yield* ok(rendered.includes("PASS") && rendered.includes("FAIL") && rendered.includes("ERROR"), "verdict column rendered")
  yield* ok(rendered.includes("pipeline boundedness"), "S3/S5 in-process caveat is printed with the report")

  const parsed = yield* Schema.decodeUnknownEffect(JsonValue)(toJsonReport([okMeasurement], metadata))
  const parsedRecord = parsed as { readonly measurements: ReadonlyArray<{ readonly verdict: string }>; readonly machine: { readonly nodeVersion: unknown } }
  yield* equal(parsedRecord.measurements[0]!.verdict, "PASS", "JSON verdict changed")
  yield* ok(typeof parsedRecord.machine.nodeVersion === "string", "node version missing")

  yield* Console.log("selfcheck OK")
})

NodeRuntime.runMain(program, { disableErrorReporting: false })
