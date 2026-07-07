// Plain-assert verification for the bench harness — run with: bun bench/selfcheck.ts
// The bench is quarantined from vitest by design (spec §3); this file is its test suite.
import assert from "node:assert/strict"
import { verdictFor, BUDGETS, RSS_BUDGET_BYTES } from "./budgets"

// --- budgets & verdicts ---
assert.equal(verdictFor("s2-warm-boot-t0", 100, 0, 1_000_000), "PASS", "under ms budget → PASS")
assert.equal(verdictFor("s2-warm-boot-t0", 200, 0, 1_000_000), "WATCH", "≤2× ms budget → WATCH")
assert.equal(verdictFor("s2-warm-boot-t0", 400, 0, 1_000_000), "FAIL", ">2× ms budget → FAIL")
// throughput budget: s1 wants ≥50k events/s → 100k events in 1s passes, in 4s watches, in 10s fails
assert.equal(verdictFor("s1-cold-boot", 1_000, 100_000, 0), "PASS", "throughput above floor → PASS")
assert.equal(verdictFor("s1-cold-boot", 4_000, 100_000, 0), "WATCH", "throughput within 2× of floor → WATCH")
assert.equal(verdictFor("s1-cold-boot", 10_000, 100_000, 0), "FAIL", "throughput >2× under floor → FAIL")
// RSS budget applies to every key, even unbudgeted ones
assert.equal(verdictFor("s3-e2e-cold", 1, null, RSS_BUDGET_BYTES + 1), "WATCH", "RSS just over budget → WATCH")
assert.equal(verdictFor("s3-e2e-cold", 1, null, RSS_BUDGET_BYTES * 3), "FAIL", "RSS >2× budget → FAIL")
assert.equal(verdictFor("s3-e2e-cold", 999_999, null, 0), "PASS", "no ms/throughput budget → RSS alone decides")
assert.equal(verdictFor("s1-cold-boot", 1, 1, 0, "boom"), "ERROR", "error always wins")
assert.ok(Object.keys(BUDGETS).length === 8, "all eight scenario keys budgeted")

// --- generator ---
import { Effect, Exit, Schema } from "effect"
import { DomainEventFromJson } from "@yodea/contracts/events/domain"
import { Project } from "@yodea/contracts/project"
import { generateEvents, LIVE_PROJECT_CAP, ProjectsFromJson, SCALES } from "./seed"

const takeEvents = (n: number, seed?: number) => {
  const out = []
  for (const e of generateEvents(n, seed)) out.push(e)
  return out
}

// determinism: same seed → byte-identical script
assert.deepEqual(
  takeEvents(500).map((e) => JSON.stringify(e)),
  takeEvents(500).map((e) => JSON.stringify(e)),
  "same seed must produce an identical event script"
)
// different seed → different script
assert.notDeepEqual(
  takeEvents(500).map((e) => JSON.stringify(e)),
  takeEvents(500, 7).map((e) => JSON.stringify(e)),
  "different seed must diverge"
)

// live-population cap: replaying create/delete never exceeds LIVE_PROJECT_CAP
{
  const alive = new Set<string>()
  for (const e of generateEvents(5_000)) {
    if (e._tag === "ProjectCreated") alive.add(e.projectId)
    if (e._tag === "ProjectDeleted") alive.delete(e.projectId)
    assert.ok(alive.size <= LIVE_PROJECT_CAP, "live population exceeded the cap")
  }
  assert.ok(alive.size > 0, "population died out — generator is degenerate")
}

// every event round-trips the PRODUCTION payload codec (what seeding will store)
// (encode via runSyncExit(Schema.encodeEffect(...)) — the exact API event-store.ts
// uses; if-throw instead of assert.ok so TypeScript narrows the Exit)
for (const e of takeEvents(2_000)) {
  const encoded = Effect.runSyncExit(Schema.encodeEffect(DomainEventFromJson)(e))
  if (!Exit.isSuccess(encoded)) throw new Error(`event failed to encode: ${e._tag}`)
  const decoded = Schema.decodeUnknownExit(DomainEventFromJson)(encoded.value)
  if (!Exit.isSuccess(decoded)) throw new Error(`event failed to decode back: ${e._tag}`)
}

// the branded-type trap (global constraints): a folded Project built from generated
// events must survive the CHECKED checkpoint decode used at boot (projections.ts:52-60)
{
  const created = takeEvents(50).filter((e) => e._tag === "ProjectCreated")
  assert.ok(created.length > 0, "no creates in the first 50 events")
  const projects = created.map((e) => Project.fromCreated(e as never))
  const stateJson = Effect.runSyncExit(Schema.encodeEffect(ProjectsFromJson)(projects))
  if (!Exit.isSuccess(stateJson)) throw new Error("checkpoint state failed to encode")
  const back = Schema.decodeUnknownExit(ProjectsFromJson)(stateJson.value)
  if (!Exit.isSuccess(back)) throw new Error("checkpoint state failed CHECKED decode — ids/names/tags are not brand-valid")
}

// scales are what the spec says
assert.deepEqual(SCALES, { smoke: 1_000, "100k": 100_000, "1m": 1_000_000, "10m": 10_000_000 })

console.log("selfcheck OK")
