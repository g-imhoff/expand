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

console.log("selfcheck OK")
