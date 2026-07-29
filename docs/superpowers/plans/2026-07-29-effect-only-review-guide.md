# Effect-Only Review Guide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the existing `REVIEW.md` review history while reopening every previously completed entry changed by the Effect-only migration and adding a complete reviewer-oriented path for the migration itself.

**Architecture:** `REVIEW.md` remains one dependency-ordered guide. Existing Stages 0–7 retain their role; status reconciliation reopens exact changed entries, migration concerns are added to the relevant runtime stages, and new Stages 8–9 cover development surfaces and permanent certification machinery without duplicating the original architecture tour.

**Tech Stack:** Markdown, Git history, ripgrep, repository Effect audit and architecture tests.

## Global Constraints

- Work only in `/home/gimhoff/projects/expand/.worktrees/effect-only-migration` on `feature/effect-only-migration`.
- Preserve the existing guide and its already-reviewed material; do not rewrite it from scratch.
- Treat `dd83af88c04159ac6847c62271078e607ff3e3fd..e7d9fc62cc0460d1a402a1bff654c8a75ab24743` as the Effect-only implementation range.
- `DONE` may remain only when all files named by an entry are unchanged in that range.
- New and reopened review work must not be marked complete.
- Certification evidence is informational and must not substitute for user review.
- Do not change production code, tests, policies, inventories, or configuration.
- Keep commit-stamped counts separate from permanent invariants.
- Use only paths and commands that exist at HEAD.

---

### Task 1: Refresh the complete review guide

**Files:**
- Modify: `REVIEW.md`
- Reference: `docs/superpowers/specs/2026-07-29-effect-only-review-guide-design.md`
- Reference: `docs/architecture/EFFECT_ONLY.md`
- Reference: `docs/architecture/BOUNDARIES.md`
- Reference: `docs/superpowers/plans/2026-07-13-effect-only-host-boundaries.md`
- Reference: `docs/superpowers/plans/2026-07-13-effect-only-development-surfaces.md`
- Reference: `docs/superpowers/plans/2026-07-13-effect-only-final-certification.md`

**Interfaces:**
- Consumes: existing Stages 0–7, exact migration range, final inventories, architecture policies, and final certification evidence.
- Produces: one self-contained guide that distinguishes retained `DONE` work, reopened work, new migration stages, mandatory scrutiny, representative sampling, and focused verification commands.

- [ ] **Step 1: Capture the pre-edit failures**

Run:

```bash
rg -n 'scripts/binary-smoke\.sh|the eight forbidden|Thirteen "fitness tests"|Depends on `contracts` \+ `server`|the \*\*duplicated\*\* `@expand/\*` alias maps' REVIEW.md
! rg -n '^### Stage 8 — Migrated development surfaces|^### Stage 9 — Permanent ratchets and certification' REVIEW.md
```

Expected: the first command reports stale guidance and the second command succeeds because the required new stages are absent.

- [ ] **Step 2: Reconcile existing review state exactly**

Retain existing `DONE` markers only for unchanged entries. Remove `DONE` from these changed entries:

```text
Stage 0: BOUNDARIES.md; expand.c4
Stage 2: event-store.ts/replay-feed.ts/project-event-store.ts group;
         projection-state-store.ts/application/projections.ts group;
         application/projects/use-cases.ts;
         http.ts;
         state-root-lock.ts;
         composition/app.ts/main.ts group
Stage 3: ARCHITECTURE.md;
         index.ts/project/index.ts/server/index.ts group;
         adapter.ts;
         discovery.ts/spawn.ts/spawn-lock.ts group;
         rpc-client.ts;
         adapters/node.ts;
         client-session.ts
```

Retain `DONE` for the unchanged Stage 1 entries and the unchanged Stage 2 event vocabulary, event bus, connection tracker, and RPC-handler entries. Preserve historical date notes as prose attached to reopened entries rather than as status tokens.

Add this meaning near `## The review path`:

```text
DONE means the entry was reviewed before the Effect-only migration and none of its referenced files changed in dd83af8..e7d9fc6. An unmarked, UPDATED, or MOVED entry requires review. If any file in a grouped entry changed, the whole entry is reopened. Certification evidence does not mark review work complete.
```

- [ ] **Step 3: Refresh Stage 0 and the architecture overview**

Change the overview wording to state that core Effect APIs come from `effect`, while selected CLI/process/RPC APIs come from `effect/unstable/*`.

Add `docs/architecture/EFFECT_ONLY.md` to Stage 0 after `BOUNDARIES.md`. Explain:

```text
Effect is required for I/O, ambient inputs, async/cancellation, recoverable failure, mutable concurrency, and acquisition/release. Pure folds, reducers, routing, formatting, validation, and path calculations over supplied inputs remain ordinary functions.
```

Extend the state-root description with default-root versus explicit-root coordination, the external default-root spawn lock, root-local explicit lock, and fail-closed ownership behavior. Require reviewers to reconcile the complete I-1 through I-4 enforcement map with existing paths.

- [ ] **Step 4: Add Effect-specific rereview guidance to Stages 1–6**

Preserve each stage’s existing behavioral purpose while adding exact scrutiny where migration files changed:

```text
Stage 1: AppContext remains pure derivation; host roots acquire cwd/home/argv and provide it.
Stage 2: Effect platform services, state-root ownership, bounded HTTP teardown, separately guaranteed core closure, exact directory identity, typed failures, and cleanup Causes.
Stage 3: ProcessServices/ChildProcess, spawn election retry under one deadline, ProjectSync epochs, session cleanup Causes, and no source dependency on apps/server.
Stage 4: Effect CLI runner, Stdio/Path services, typed CLI failure rendering, and stable envelope behavior.
Stage 5: owned TUI root/runtime/synchronization/mutation fibers while reducers and routing remain pure.
Stage 6: exact packaged renderer identity, IPC admission, MessagePort/RPC scopes, preload/renderer unload ownership, supervised mutation callbacks, Effect Crypto nonce generation, and cleanup Cause preservation.
```

Correct Stage 3’s dependency statement to:

```text
Depends on contracts and Effect/platform packages; interoperates with and may launch the separately built server through the backend-command seam, without importing apps/server.
```

- [ ] **Step 5: Correct and expand Stage 7**

Replace the fixed architecture-test count with a description of the suite. Add these mandatory gates and explain the failure each prevents:

```text
test/architecture/effect-audit.test.ts
test/architecture/effect-candidate-inventory.test.ts
test/architecture/effect-executable-inventory.test.ts
test/architecture/effect-final-ratchet.test.ts
test/architecture/effect-version-lockstep.test.ts
```

Correct infrastructure guidance:

```text
- describe nine dependency-cruiser rules, including renderer-no-node-appcontext;
- replace scripts/binary-smoke.sh with scripts/binary-smoke.ts;
- review scripts/fixtures/job-control.sh as the narrow registered shell host boundary;
- state that workspace packages resolve through package exports in Vitest while app/internal aliases remain explicit;
- preserve module-order and agent-orchestration material.
```

- [ ] **Step 6: Add Stage 8 — Migrated development surfaces**

Create a 60–90 minute stage with sections for:

```text
1. Shared Effect-aware architecture/test helpers
2. Contracts/client/server test migration and process fixtures
3. Desktop/TUI UI adapters and Playwright host bridge
4. Build, fold-version, agent-sync, desktop, package, and manifest programs
5. Public client examples and smoke harnesses
6. Benchmark scopes and six-row smoke reporting
7. Compiled binary certification model
```

For each section provide exact representative files, highest-risk scrutiny, and matching tests. Explicitly permit sampling repetitive fixture-only syntax conversions, but require complete review of shared lifecycle helpers, process fixtures, transactional filesystem programs, and host-required Promise adapters.

- [ ] **Step 7: Add Stage 9 — Permanent ratchets and certification**

Create a 75–105 minute stage with this reading order:

```text
docs/architecture/EFFECT_ONLY.md
eslint-rules/effect-boundary-analysis.mjs
eslint-rules/effect-boundary.mjs
eslint-rules/effect-host-boundaries.mjs
scripts/effect-audit.ts
effect-candidate-inventory.json and its model/tests
effect-executable-inventory.json and its model/tests
scripts/package-certification.ts
scripts/binary-smoke.ts
final repair commits a0ed15b, 78ebfce, fdda3aa, e7d9fc6
```

Require scrutiny of semantic non-vacuity, exact source-consumer coverage, warning/message handling, exact host exceptions, candidate bijection, fail-closed executable resolution, process/filesystem ownership, cleanup Cause preservation, renderer trust, abnormal HTTP/core release, symlink directory identity, failed-spawner re-election, and complete architecture policy links.

Add a command matrix:

```bash
npm run effect:audit
npm run effect:candidates
npm run effect:launchers
npm run lint
npm run typecheck:all
npm run typecheck:desktop
npm run arch
npm run knip
npx knip --directory docs/architecture
npm test
npm run bench:selfcheck
npm run bench:events -- --smoke
npm run cert:cli:build
npm run cert:packages
xvfb-run -a npm run e2e:desktop
```

State that `effect:grep` is discovery only and that no baseline/updater command exists.

- [ ] **Step 8: Refresh the fast path and evidence wording**

Increase the full-path and fast-path estimates to account for migration review. Keep commit-stamped evidence at `e7d9fc6`, explicitly distinguish the documentation-only later commit, and move mutable inventory counts out of “Permanent guarantees” into final evidence.

Make the fast path include:

```text
EFFECT_ONLY.md and BOUNDARIES.md
AppContext/data-dir/lock trace
server HTTP/core and cleanup ownership
client session/ProjectSync epochs
Electron packaged identity and port lifecycle
semantic analyzer and exact host registry
audit, candidate, executable, and final-ratchet tests
binary/package certification models
```

Use a valid explicit anchor for the fast path or a renderer-safe heading/link pair.

- [ ] **Step 9: Verify statuses, paths, contents, and formatting**

Run:

```bash
! rg -n 'scripts/binary-smoke\.sh|the eight forbidden|Thirteen "fitness tests"|Depends on `contracts` \+ `server`|the \*\*duplicated\*\* `@expand/\*` alias maps' REVIEW.md
rg -n '^### Stage 8 — Migrated development surfaces|^### Stage 9 — Permanent ratchets and certification' REVIEW.md
rg -n 'effect-audit\.test\.ts|effect-candidate-inventory\.test\.ts|effect-executable-inventory\.test\.ts|effect-final-ratchet\.test\.ts|effect-version-lockstep\.test\.ts' REVIEW.md
rg -n 'npm run effect:audit|npm run effect:candidates|npm run effect:launchers' REVIEW.md
git diff --check
```

Mechanically inspect every remaining `DONE` entry against:

```bash
git diff --name-only dd83af8..e7d9fc6
```

Verify all backticked repository paths exist, allowing only explicitly labelled historical commits/ranges and deleted-path warnings. Expected: no retained `DONE` entry references a changed file; no unexplained missing path; all required stages/gates/commands are present; `git diff --check` is silent.

- [ ] **Step 10: Run repository documentation-facing gates**

Run:

```bash
npm run effect:audit
npm run lint
npm run typecheck:all
npm run knip
npx knip --directory docs/architecture
```

Expected: all commands exit 0; audit reports zero blocking findings and zero advisories.

- [ ] **Step 11: Commit**

```bash
git add REVIEW.md
git commit -m "docs: add Effect-only migration review path"
```

Expected: the commit changes only `REVIEW.md`.
