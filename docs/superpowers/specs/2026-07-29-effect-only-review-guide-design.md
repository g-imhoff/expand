# Effect-Only Review Guide Refresh

## Goal

Update `REVIEW.md` so a reviewer can fully assess the Effect-only migration without losing the review state recorded before that migration.

## Review boundary

The Effect-only design and planning sequence ends at `dd83af8`. The implementation review range is therefore:

```text
dd83af88c04159ac6847c62271078e607ff3e3fd..e7d9fc62cc0460d1a402a1bff654c8a75ab24743
```

`417959203caba414853949caa2903b000c769480` is the later documentation-only certification record. It is not part of the implementation range.

The existing Stages 0–7 remain the review guide for the earlier architectural foundation. They must not be discarded or replaced by a branch-wide rewrite.

## Review-state reconciliation

`DONE` means the referenced implementation was reviewed and did not change in the Effect-only implementation range.

For each existing `DONE` entry:

- retain `DONE` when none of its referenced files changed in the implementation range;
- remove `DONE` when any referenced file changed;
- reopen an entire grouped entry when any constituent file changed;
- preserve useful historical notes as re-review context rather than leaving malformed status prefixes.

Entries already marked `UPDATED`, `MOVED`, or unmarked remain pending. New stages and entries start pending. Certification evidence never marks an item complete.

A legend near the start of the review path must state these rules and the exact implementation boundary.

## Structure

### Stage 0 — Architecture anchors

Preserve the existing architecture introduction, add `docs/architecture/EFFECT_ONLY.md`, reopen changed boundary/C4 documents, and establish the functional-core/effectful-shell policy before runtime rereview.

### Stages 1–6 — Existing product layers

Preserve their dependency order and prior prose where accurate. Reopen changed entries and add migration-specific scrutiny where behavior or lifecycle ownership changed:

- explicit services instead of ambient host inputs;
- typed recoverable failures versus defects;
- interruption and scoped acquisition/release;
- complete cleanup `Cause` preservation;
- exact host-adapter confinement;
- named reusable Effect operations;
- process, synchronization, MessagePort, renderer, mutation, and TUI ownership.

Correct stale descriptions encountered in these stages, including the client SDK dependency statement and selected `effect/unstable/*` usage.

### Stage 7 — Enforcement and infrastructure

Preserve the existing enforcement/module-order/agent sections while expanding and correcting them:

- include the Effect audit, candidate inventory, executable inventory, final ratchet, and Effect version tests;
- avoid stale hard-coded architecture-test counts;
- describe all nine dependency-cruiser rules or avoid an incorrect count;
- replace deleted `scripts/binary-smoke.sh` references with `scripts/binary-smoke.ts` plus `scripts/fixtures/job-control.sh`;
- describe current Vitest workspace-package resolution rather than obsolete duplicated aliases;
- retain module-order and agent-orchestration review guidance.

### Stage 8 — Migrated development surfaces

Add a reviewer-oriented path through shared test/runtime adapters, server/client/UI/E2E fixtures, repository build and manifest programs, examples, benchmarks, and the binary smoke model. Identify shared helpers whose lifecycle semantics deserve full review and repetitive mechanical conversions that may be sampled.

### Stage 9 — Permanent ratchets and certification

Add a dependency-ordered path through:

1. `docs/architecture/EFFECT_ONLY.md`;
2. semantic boundary analysis and exact host-boundary policy;
3. cumulative audit orchestration and source-consumer coverage;
4. candidate inventory bijection and zero-advisory cutover;
5. executable inventory discovery and fail-closed resolution;
6. package and compiled-binary certification;
7. final repair waves and the behaviors they fixed;
8. focused and cumulative verification commands.

Mutable inventory counts belong in commit-stamped evidence, while permanent guarantees are stated as invariants.

### Fast path

Refresh the fast path so it includes Effect policy, runtime ownership and synchronization, audit non-vacuity, host boundaries, both final inventories, and final-ratchet tests. Correct stale file paths and update the time estimate to account for this work.

## Accuracy requirements

The guide must:

- use paths that exist at HEAD;
- distinguish implementation certification at `e7d9fc6` from the later documentation-only commit;
- retain exact final evidence as commit-stamped evidence rather than presenting changing counts as timeless guarantees;
- preserve previously reviewed material unless it is inaccurate or its referenced files changed;
- give every reopened or new area a reading order, scrutiny questions, and matching tests or commands;
- clearly identify representative sampling versus mandatory full review;
- keep the existing guided-review voice and formatting.

## Verification

After editing:

1. mechanically compare every remaining `DONE` entry with `git diff --name-only dd83af8..e7d9fc6` and prove no retained entry references a changed file;
2. verify every backticked repository path in the guide exists, except explicit historical/deleted-path discussion;
3. reject remaining `scripts/binary-smoke.sh` instructions;
4. verify the guide contains the Effect policy, audit, host registry, candidate inventory, executable inventory, final-ratchet tests, and focused commands;
5. check headings and local anchors;
6. run Markdown-facing repository checks applicable to the changed files, `git diff --check`, and final clean-tree verification after commit.

## Non-goals

- Rewriting the architectural foundation guide from scratch.
- Marking any Effect migration work as reviewed on the user's behalf.
- Adding or changing production behavior.
- Reproducing every audit fixture or inventory record line by line in `REVIEW.md`.
