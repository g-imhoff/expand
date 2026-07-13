# Event-store benchmark harness

Manual macro-benchmark for the event-store architecture (keyset `scan`,
checkpointed projection boot, RPC replay) at scales far beyond real usage.
Design: `docs/superpowers/specs/2026-07-06-event-store-benchmark-design.md`.

**Quarantined by design:** nothing here is reachable from vitest, coverage,
knip, depcruise, or the eslint rule block. Verification is `npm run bench:selfcheck`
plus `npm run bench:events -- --smoke`. Zero production code is imported mutably —
only public layers/exports.

## Run

    npm run bench:events                            # default: 100k + 1m, all scenarios
    npm run bench:events -- --smoke                 # 1k events, seconds — harness sanity
    npm run bench:events -- --scale 10m             # opt-in, seeding takes minutes
    npm run bench:events -- --scenario s1 --scenario s4 --chunk 200
    npm run bench:events -- --json out.json --reseed

## Scenarios

| id | what | budget (first guess) |
|----|------|----------------------|
| s1 | cold boot: from-zero streamed fold (layer-level) | ≥ 50k events/s |
| s2 | warm boot: tail catch-up at T ∈ {0, 1k, 10k} | ≤ 150ms (t0/t1k) |
| s4 | scan drain: `ReplayFeed.read(0)` fully consumed | ≥ 100k events/s |
| s3 | e2e: real server boot → client `ProjectList` (warm + cold) | warm ≤ 300ms |
| s5 | e2e: client drains `Events({fromSeq: 0})` backlog | ≥ 20k events/s |

Every scenario also reports peak ΔRSS (budget ≤ 200MB at every scale — the
boundedness proxy: if ΔRSS grows with event count, whole-log materialization
has snuck back in).

Verdicts: PASS (≤ budget) / WATCH (≤ 2×) / FAIL (> 2×) / ERROR (scenario died).
Budgets live in `budgets.ts` and are deliberately first guesses — recalibrate
them after reading a real run on your machine.

At `--smoke` scale, verdicts consider only ΔRSS and errors: smoke exists to
verify the harness itself in seconds, and ms/throughput budgets are
mathematically unmeetable over 1k events where fixed costs dominate.

Caveats: S3/S5 run server + client in one process (ΔRSS = pipeline, not
per-side; S1/S4 attribute per side). Warm-boot correctness depends on planted
checkpoints being decodable — pinned by `selfcheck.ts`'s roundtrip check.

## Seeding

Deterministic (PRNG seed 42): ~200 live projects, weighted lifecycle events,
UUID-v4-shaped ids and brand-valid names/tags. Cached in `.cache/` keyed by
scale + seed + `GENERATOR_VERSION` (bump it in `seed.ts` when the generator
changes). Rows are written via batched SQL with the production
`DomainEventFromJson` encoder and validated through the real `ReplayFeed`.
