# Reviewing `feat/architectural-foundation`

This file has two review scopes. Start with **Current change-set re-review**:
it covers every staged, unstaged, added, and deleted path in the current cleanup
and must be completed again for this change. The longer dependency-ordered path
that follows remains the guide for reviewing the architectural foundation as a
whole.

The whole-branch guide orders review by the **dependency graph**: read each layer
only after the layers it is built on. By the time you reach a frontend, you
already understand the vocabulary, backend, and connection logic it relies on,
so nothing is reviewed in a vacuum.

> **How to use this**
> - Each stage has a *plain-language summary*, *why it comes here*, a *file-by-file reading order*, the *handful of things worth scrutinizing hardest*, and the *tests that best prove intent*.
> - The module-order migration touched 55 configured TypeScript files across the graph. When an earlier stage shows a move-only diff, verify that the declaration body and owned comments stayed intact; Stage 7b explains the rule and the few non-mechanical transformations.
> - Time estimates are for a careful human review. The full path is ~14–17 hours. If you can't spend that, jump to **[The fast path](#the-fast-path)**.
> - The whole branch is built to satisfy four load-bearing invariants (**I-1 … I-4**). Stage 0 explains them; every later stage references them.

## Current change-set re-review

The `DONE` labels in the historical path do not apply to files listed here.
Every listed path is reopened. Review staged and unstaged hunks together because
`docs/architecture/BOUNDARIES.md` currently participates in both the state-root
lock change and the Effect-enforcement cleanup. Added files must be inspected
explicitly; they do not appear in a plain `git diff` until tracked.

Start by establishing the exact scope:

```bash
git status --short
git diff --name-status HEAD
git diff --cached --name-status
git diff --check HEAD
```

For a pull request, compare the head with its merge base instead of local
`HEAD`, then confirm that the resulting paths still fit the five waves below.
An unexpected path reopens the relevant wave and must be added to this guide.

### Wave 1 — state-root spawn-lock ownership · 🔴 high

**Changed scope:**

- `packages/contracts/app-context.ts`
- `packages/contracts/test/app-context.test.ts`
- `docs/architecture/BOUNDARIES.md`

**Intent:** every state root, including the implicit or explicitly selected
channel default, now derives its client spawn lock as
`<state-root>/server.json.lock`. The external `<home>/.expand-locks/*` location
remains only for legacy migration coordination.

**Read next:** `packages/client-ts/spawn.ts`,
`packages/client-ts/spawn-lock.ts`,
`packages/client-ts/test/integration/find-or-spawn.test.ts`,
`packages/client-ts/test/integration/spawn-lock.test.ts`,
`apps/cli/test/contract/contract.test.ts`, and
`apps/desktop/e2e/helpers.ts`.

**Scrutinize hardest:**

- Implicit and explicit-equal defaults must resolve to the same data directory,
  endpoint, and spawn lock; different roots must never share a lock.
- The lock parent must exist or be created before acquisition, and success,
  failure, interruption, stale-owner recovery, and contention must leave no
  lock artifacts.
- Mixed old/new clients may coordinate through different spawn-lock paths. The
  state-root ownership lock and endpoint handshake must still prevent two live
  writers or an incorrect endpoint from winning.
- Confirm whether this operational compatibility change needs a product,
  protocol, schema, migration, or cache version change. If no bump is needed,
  the review should record why none of those compatibility domains changed.
- `BOUNDARIES.md`, the derived `AppContext`, compiled CLI behavior, and tests
  must describe the same rule with no surviving default-root exception.

**Focused evidence:**

```bash
npx vitest run packages/contracts/test/app-context.test.ts \
  packages/client-ts/test/integration/find-or-spawn.test.ts \
  packages/client-ts/test/integration/spawn-lock.test.ts \
  apps/cli/test/contract/contract.test.ts
npm run cert:cli:build
```

### Wave 2 — executable source cleanup · 🟢 low

**Changed scope:**

- `apps/cli/cli/commands/project/create.ts`
- `apps/cli/cli/commands/project/resolve-project-target.ts`
- `packages/client-ts/project/client.ts`

**Intent:** remove repository-owned explanatory comments and make no runtime,
type, public API, validation, or error-mapping change.

Review the word diff. The `ProjectClientApi`, service identity, command options,
UUID/name resolution, backend validation boundary, and generated output must be
identical. Any change beyond comments or whitespace is out of scope and reopens
the owning CLI/client tests.

```bash
git diff --word-diff=plain HEAD -- \
  apps/cli/cli/commands/project/create.ts \
  apps/cli/cli/commands/project/resolve-project-target.ts \
  packages/client-ts/project/client.ts
npx vitest run apps/cli/test/unit/resolve-target.test.ts \
  apps/cli/test/contract/contract.test.ts \
  packages/client-ts/test/integration/client-layer.test.ts
```

### Wave 3 — permanent Effect enforcement without audit inventories · 🔴 high

**Removed scope:**

- `effect-candidate-inventory.json` and `effect-executable-inventory.json`
- `scripts/effect-audit*`, `scripts/effect-candidate-inventory*`,
  `scripts/effect-executable-inventory*`, and `scripts/effect-policy-model.ts`
- `test/architecture/effect-audit.test.ts`,
  `test/architecture/effect-boundary-registry.test.ts`,
  `test/architecture/effect-candidate-inventory.test.ts`, and
  `test/architecture/effect-executable-inventory.test.ts`
- `tsconfig.effect-audit.json`

**Added scope:**

- `tsconfig.workspace.json`
- `test/architecture/effect-host-boundaries.test.ts`
- `test/architecture/effect-policy.test.ts`

**Modified scope:** `.githooks/pre-commit`, `.github/workflows/ci.yml`,
`CODEOWNERS`, `docs/architecture/BOUNDARIES.md`,
`docs/architecture/EFFECT_ONLY.md`, the sibling `VERSIONING.md`,
`eslint-rules/effect-host-boundaries.mjs`, `eslint.effect.config.mjs`,
`knip.jsonc`, `package.json`, `package-lock.json`, `tsconfig.json`,
`vitest.config.ts`, and these architecture suites:

- `effect-boundary-coverage.test.ts`
- `effect-certification.test.ts`
- `effect-final-ratchet.test.ts`
- `effect-language-service.test.ts`
- `manifest-orchestration.test.ts`
- `node-only.test.ts`
- `test-colocation.test.ts`
- `version-policy.test.ts`

**Intent:** replace the generated JSON ledgers and custom `effect:audit` program
with permanent, directly inspectable enforcement: whole-tree semantic ESLint,
patched TypeScript language-service diagnostics, an exact host-boundary
registry, source-coverage tests, architecture policy tests, and human review for
judgment-heavy adoption decisions.

**Scrutinize hardest:**

- `tsconfig.workspace.json` and ESLint must cover every existing tracked or
  newly added first-party TS/JS source while excluding only generated output,
  dependencies, reports, and separate worktrees.
- `npm run typecheck:all` must run through patched TypeScript and fail on Effect
  errors, warnings, suggestions, and `effectFnOpportunity` diagnostics. The
  lifecycle split between `postinstall` (Git hooks) and `prepare` (language
  service patching) must work after a clean `npm ci`.
- Disabling duplicate language-service checks for Node builtins and bare
  `process.env` must not create a gap: the semantic ESLint rule and exact host
  registry must reject unapproved occurrences.
- Every remaining host-boundary record must identify one tracked file,
  declaration, construct, occurrence, and consumer. Removed entries must
  correspond only to files deleted in this change.
- Deleting the candidate/executable inventories must not delete behavioral
  guarantees for typed failures, resource ownership, interruption, cleanup,
  runner placement, or complete `Cause` preservation. Those are now explicit
  manual-review responsibilities backed by focused behavior tests.
- Pre-commit must retain lint and aggregate typecheck. CI must retain lint,
  aggregate typecheck, architecture, Knip, tests, package certification,
  benchmarks, desktop E2E, and compiled-binary certification.

**Focused evidence:**

```bash
npx vitest run \
  test/architecture/effect-policy.test.ts \
  test/architecture/effect-host-boundaries.test.ts \
  test/architecture/effect-boundary-coverage.test.ts \
  test/architecture/effect-language-service.test.ts \
  test/architecture/effect-final-ratchet.test.ts \
  test/architecture/effect-certification.test.ts \
  test/architecture/manifest-orchestration.test.ts \
  test/architecture/node-only.test.ts \
  test/architecture/test-colocation.test.ts \
  test/architecture/version-policy.test.ts
```

### Wave 4 — repository-local agent definitions removed · 🟡 medium

**Changed scope:**

- all tracked files under `.claude/agents/` and `.codex/agents/`
- `.codex/config.toml`
- `scripts/sync-agents.ts` and `scripts/sync-agents.test.ts`
- `AGENTS.md`, `.githooks/pre-commit`, `.github/workflows/ci.yml`,
  `package.json`, `package-lock.json`, and
  `test/architecture/manifest-orchestration.test.ts`

**Intent:** agent profiles and routing live outside the product repository. The
repository keeps only its code-authoring rules; installs, commits, and CI no
longer synchronize editor-specific agent definitions.

Confirm that no product, build, hook, test, or workflow imports the removed
files; `smol-toml` is no longer a direct project dependency now that the
synchronizer is gone, even though Knip still owns it transitively; the lockfile
matches the manifest; and the install lifecycle still both configures hooks and
patches TypeScript. The external plugin is not evidence for repository
correctness: this tree must remain buildable and testable without it.

```bash
! rg -n --hidden \
  'agents:(sync|check)|sync-agents|\.codex/agents|\.claude/agents' \
  -g '!.git/**' -g '!REVIEW.md' .
node -e "const p=require('./package.json'); process.exit(p.dependencies?.['smol-toml'] || p.devDependencies?.['smol-toml'] ? 1 : 0)"
npm run knip
```

The search should return no active repository reference. Historical text, if
deliberately retained later, must not be executable configuration.

### Wave 5 — automated Codex pull-request review removed · 🟡 medium

**Removed scope:**

- `.github/workflows/codex-review-request.yml`
- `.github/workflows/codex-review.yml`
- `.github/codex/review-comment.cjs`
- `.github/codex/review-comment.d.cts`
- `.github/codex/review-schema.json`
- `test/architecture/codex-review.test.ts`
- `docs/superpowers/plans/2026-08-03-versioning-p0-p4.md`
- `docs/superpowers/plans/2026-08-03-versioning-p4-codex-review.md`
- `docs/superpowers/specs/2026-08-03-versioning-and-codex-review-design.md`

**Updated scope:** `.github/workflows/ci.yml`,
`docs/architecture/BOUNDARIES.md`, `docs/architecture/EFFECT_ONLY.md`,
the sibling `VERSIONING.md`, `REVIEW.md`,
`docs/superpowers/plans/2026-08-03-versioning-p2-compatibility-ownership.md`,
`docs/superpowers/plans/2026-08-03-versioning-p3-policy-enforcement.md`,
`eslint-rules/effect-host-boundaries.mjs`,
`test/architecture/effect-certification.test.ts`,
`test/architecture/effect-final-ratchet.test.ts`, and
`test/architecture/version-policy.test.ts`.

**Intent:** no GitHub event launches Codex, no repository code publishes an AI
review comment, and no Codex credential, CLI pin, model, schema, or self-hosted
runner is part of the pull-request pipeline. Semantic Effect and versioning
review is manual for now.

Confirm the ordinary CI workflow remains read-only at repository scope and
retains its existing product gates; no retired workflow is still referenced;
the version inventory still documents every product, protocol, migration,
stored-event, projection, benchmark, and dependency domain; and P2/P3 historical
plans remain internally coherent after removing P4.

```bash
! rg -n --hidden \
  'codex-review|openai/codex-action|CODEX_API_KEY|review-comment\.cjs|review-schema\.json|codex-version|gpt-5\.6-luna' \
  -g '!.git/**' -g '!REVIEW.md' .
npx vitest run test/architecture/effect-policy.test.ts \
  test/architecture/effect-final-ratchet.test.ts \
  test/architecture/effect-host-boundaries.test.ts \
  test/architecture/effect-certification.test.ts \
  test/architecture/version-policy.test.ts
```

The search should produce no active workflow, configuration, helper, schema, or
test match.

### Cumulative acceptance for this change set

Focused tests prove intent; they do not replace the repository gates. Complete
the review only after `git diff --check HEAD` is clean, every deleted-path
reference is either removed or deliberately historical, and these commands
pass from the same checkout:

```bash
npm run lint
npm run typecheck:all
npm run arch
npm run knip
NODE_ENV=test npm test
npm run cert:packages
npm run cert:cli:build
```

For each failure, decide whether the implementation, the replacement gate, or
this review guide is wrong; do not weaken an assertion only to restore green.
Record the exact command, exit code, and relevant test count in the pull-request
review.

### Latest local evidence — 2026-08-11

This evidence applies to the exact working tree used to update this guide and
must be regenerated after any further source, configuration, or test change:

- Both retired-reference searches returned no match, and `smol-toml` was absent
  from the root dependency sets.
- The 16 focused suites passed 166 tests.
- ESLint, aggregate TypeScript/Effect diagnostics, dependency-cruiser, Knip,
  package certification, and compiled CLI/server certification exited 0.
- Full Vitest passed 166 files and 1,261 tests plus one expected failure with
  `NODE_ENV=test`.
- `git diff --check HEAD` reported no whitespace error.

## Effect-only migration certification

The Effect-only implementation range is `dd83af88c04159ac6847c62271078e607ff3e3fd..e7d9fc62cc0460d1a402a1bff654c8a75ab24743`. It was reviewed and certified at `e7d9fc62cc0460d1a402a1bff654c8a75ab24743` relative to merge base `9a5fa7830d9445b1ef0b9c7682481a5b45acb57d`. The later `417959203caba414853949caa2903b000c769480` commit records documentation-only certification and is not part of the implementation range.

### Permanent guarantees

- The npm `prepare` lifecycle patches both local TypeScript binaries, and `npm run typecheck:all` fails on configured Effect language-service errors, warnings, and suggestions.
- Pull-request review manually applies the complete Effect adoption and lifecycle policy.
- HTTP transport teardown is bounded while its separately owned core scope closes without abandonment. Failed backend spawners release election ownership so a contender can take over within the original deadline.
- Packaged renderer loading, navigation, and IPC admission share one exact canonical file identity. MessagePort, callback, synchronization, mutation, process, and cleanup lifecycles are scoped and supervised, with cleanup failure, defect, and interruption Causes preserved.
- `docs/architecture/BOUNDARIES.md` and `docs/architecture/EFFECT_ONLY.md` are complementary load-bearing policies. Architecture tests require the complete I-1 through I-4 enforcement map and every mapped path to exist.

### Manual pull-request gate

No repository workflow performs the semantic review. For every non-draft pull
request, the reviewer must:

1. Read the complete diff and the relevant sections of
   `docs/architecture/BOUNDARIES.md`, `docs/architecture/EFFECT_ONLY.md`, and
   the central `VERSIONING.md` inventory.
2. Check every affected compatibility owner: product tag derivation, CLI
   envelope, backend protocol, SQLite migrations, stored-event revisions and
   upcasters, projection folds, and benchmark seed data.
3. Apply the Effect policy to changed executable code, including adapter
   legitimacy, `Effect.fn` ownership, resource scopes, interruption, cleanup,
   typed failures, and complete `Cause` preservation.
4. Confirm that behavior changes have focused regressions and that tests prove
   failure, cleanup, and compatibility paths rather than only happy paths.
5. Run the deterministic gates appropriate to the change. The minimum
   repository-wide set is:

   ```bash
   npm run lint
   npm run typecheck:all
   npm run arch
   npm run knip
   NODE_ENV=test npm test
   ```

6. Record actionable findings and exact verification evidence on the pull
   request. A passing automated gate is evidence, not a substitute for review
   judgment.

### Evidence boundary

The certification below predates the current change set. It remains useful for
understanding the architectural baseline, but it does not certify the new
state-root lock rule or the replacement Effect enforcement. Current evidence is
valid only when gathered after all five re-review waves above are present in the
same checkout.

### Historical certification evidence at `e7d9fc6`

- The language-service gate reported zero warnings and messages; its residual errors were the exact registered `nodeBuiltinImport` diagnostics.
- Clean root and architecture-doc installs preserved lockfiles at SHA-256 `e7dd3a5af435971242555c24123d97d0c3f76e1be6205b2e380199bda258f1dc` and `a838b86b2eb505de4e8d07fc9c05c196462491189ddfbca8dfd82076c56f3e7b`.
- Diagnostics, ESLint, all TypeScript projects, dependency-cruiser, root/docs Knip, and the five-manifest policy passed.
- Full Vitest passed 167 files and 1,423 tests plus one expected failure. Benchmark self-check and all six smoke scenarios passed.
- Root, contracts, client SDK, CLI/server binary, and desktop builds passed. Package certification, compiled-binary certification, and Electron E2E passed 6/6.
- Named manual runtime certification passed 20/20: all 16 CLI rows plus endpoint advertisement, wrong-token rejection, backend reuse, and final-client shutdown.
- Named desktop runtime certification passed all 9 exposed flows, with zero failures and the one planned `SKIP_NOT_EXPOSED`; every mutation converged in both the renderer and the compiled CLI against the same isolated data directory.
- React Doctor remained at the accepted 83/100 changed-scope baseline. Final whole-branch review reported no Critical or Important findings.
- Package, tarball, staging, temporary-directory, process, CDP, whitespace, comment, and clean-tree checks passed.

The supplemental architecture-document build exported all seven LikeC4 PNG views and generated all seven D2 sources, then stopped at the unavailable external `d2` executable (`spawn d2 ENOENT`). The required architecture behavior gate passed independently.

---

## The big picture (read this first)

Expand is an AI-assisted dev-workflow tool. This branch lays its **architectural skeleton**: a strictly layered monorepo on Node and **Effect v4 beta** where core Effect APIs come from `effect`, while selected CLI, process, and RPC APIs come from `effect/unstable/*`. Exactly **one** process owns each selected state root and every UI is a thin client.

```
                      packages/contracts          ← shared vocabulary (schemas, RPC, events)
                            │  (everyone imports this, it imports no one)
        ┌───────────────────┼─────────────────────────────┐
        ▼                                                   ▼
   apps/server   ── one backend/root ─┐          packages/client-ts
   (SQLite event log, sequencing,     │          the "connection brain":
    event bus, lifecycle, RPC)        │          discover/spawn backend,
        ▲                             │          reconnecting ClientSession,
        │  WebSocket RPC              │          session-backed facades
        │                            (frontends may NEVER import apps/server — I-1)
        │                             │
   ┌────┴──────────┬──────────────────┴──────────────┐
   ▼               ▼                                  ▼
 apps/cli       apps/tui                          apps/desktop
 (thin RPC      (Ink terminal UI,                 (Electron + React;
  client)        uses packages/ink-input)          renderer reaches backend
                                                    ONLY via a MessagePort,
                                                    using packages/electron-ipc)

   test/architecture + infra  ── mechanically PROVE all of the above holds ──
```

**The four invariants the code exists to enforce** (full text in `docs/architecture/BOUNDARIES.md`):

| | Invariant | In plain terms |
|---|---|---|
| **I-1** | Frontend isolation | No frontend (`cli`/`tui`/`desktop`) and no `client-ts` may import `apps/server/**`. The desktop renderer is stricter still: it reaches the backend *only* through a transferred `MessagePort`. This is what physically prevents a UI from booting its own private backend. |
| **I-2** | One AppLayer per state root | Only `apps/server` may host the Effect `AppLayer`; `backend.lock` permits one live backend for each normalized root while different roots may run independently. |
| **I-3** | One discovery file per state root | Each root has one endpoint file (`url`, `token`, `pid`, `protocolVersion`); clients coordinate spawning through the normalized context's external-default or root-local lease. |
| **I-4** | Zero-connection shutdown | Each backend counts connections to its own state root; the instant that count returns to 0, it shuts down. No grace period. |

**Recurring themes** worth understanding once, because they appear in almost every module:

- **Event sourcing + one shared fold.** The backend stores immutable domain events; current project state is *derived* by folding them. The fold lives in **one place** (`Project.foldList` in contracts) and is reused verbatim by the server and the framework-neutral project-sync controller, so synchronized UI state follows the same transition rules as the authoritative read model.
- **Server read-model cache (optimization).** The server no longer re-folds the whole log on every read. It keeps an **in-memory live read model** (a `SubscriptionRef`) seeded at boot from a **persisted `projection_state` row** (name-keyed: serialized state + `last_seq` + per-projection fold version) and advanced per commit — reads are O(rows), boot is O(tail-since-checkpoint). Checkpoints are written at boot, **debounced during the session (500ms quiet)**, and **once more at graceful I-4 shutdown**. Crash recovery starts from the last completed checkpoint; sustained sub-500ms updates may starve the debounce and grow the replay tail, while graceful scoped shutdown performs the final checkpoint. The row is a disposable cache stamped with `FOLD_VERSIONS.projects` (rebuild-from-zero on mismatch) and proven equal to a full replay by `snapshot-equivalence.test.ts` — *snapshot can never disagree with replay* still holds as a **checked invariant**. See the deleted historical path `docs/architecture/decisions/2026-07-05-event-store-foundation-design.md` in pre-migration history; it is not present at HEAD.
- **Protocol v2.** Long-lived clients bootstrap by (1) listing a `{projects, seq}` snapshot, (2) publishing that snapshot atomically, and (3) opening `Events({ fromSeq: seq })`. The server replays anything committed after the list cursor, while the client ignores stale or duplicate sequences, so the bootstrap window loses and double-applies nothing.
- **One explicit state root.** `AppContext` normalizes one data directory to an absolute path and derives the database, endpoint, log, and coordination paths from supplied inputs. The CLI exposes it as a true global `--data-dir` flag; the desktop and standalone server acquire raw argv at their host roots; and every spawned backend receives the same selected directory. Every implicit or explicit root uses its root-local `server.json.lock`; the separate external lock coordinates only legacy default-root migration. Ownership and migration evidence is validated fail closed: malformed, incomplete, replaced, or changing records are not reclaimed.
- **Branded scalars.** `ProjectId` / `ProjectName` / `Tag` are nominal types validated at the schema boundary — the system's trust boundary for untrusted input.
- **Effects-as-data / dependency injection.** UI logic and Electron wiring are kept pure and testable; side effects and platform primitives are isolated to a single seam each.

---

## The review path

`DONE` means the entry was reviewed before the Effect-only migration and none of its referenced files changed in `dd83af8..e7d9fc6`. An unmarked, `UPDATED`, or `MOVED` entry requires review. If any file in a grouped entry changed, the whole entry is reopened. Certification evidence does not mark review work complete.

### Stage 0 — Architecture anchors  ·  ~30 min  ·  🟡 medium

**What:** The written contract for the whole branch — the Effect-only functional-core/effectful-shell policy, the four invariants, and the C4 model.

**Why here:** Everything downstream is justified by these rules. Read them so each later module maps to a named invariant.

**Read in order:**
UPDATED 1. `docs/architecture/BOUNDARIES.md` — I-1…I-4: the rule, *why* it matters, and *how* it is enforced. Re-review the root-local spawn-lock rule, manual Effect review responsibility, and replacement enforcement path. Note the "Modifying these invariants" clause: changing a rule requires changing the doc, the C4 model, and the enforcement test together.
UPDATED 2. `docs/architecture/EFFECT_ONLY.md` — the permanent Effect boundary, host-adapter rules, commands, ratchets, and the new division between objective local gates and human review.
DONE 3. `docs/architecture/expand.c4` — the system/container/component model. Skim the `overall` and `backend` views to see the intended shape.

Effect is required for I/O, ambient inputs, async/cancellation, recoverable failure, mutable concurrency, and acquisition/release. Pure folds, reducers, routing, formatting, validation, and path calculations over supplied inputs remain ordinary functions.

**Scrutinize:** Reconcile the complete I-1 through I-4 enforcement map in `docs/architecture/BOUNDARIES.md` with every existing mapped path. Confirm the prose rules are specific enough to be enforceable and that `docs/architecture/EFFECT_ONLY.md` keeps pure deterministic calculation outside Effect while requiring typed failures, scoped ownership, and exact host boundaries for effectful behavior.

---

### Stage 1 — `packages/contracts`  ·  35–45 min  ·  🟡 medium

**What:** The shared vocabulary every other package imports and nothing imports back: branded scalars, the domain event union, the canonical `Project` read-model with its fold logic, the RPC surface, the discovery-file schema, and the runtime data-path context.

**Why here:** It is the foundation (`dependsOn: none`). Every later module speaks this language.

**Read in order:**
DONE 1. `project.ts` — **start here.** Historical review notes: 2026-07-05: fold versions became per-projection — re-read the FOLD_VERSIONS part; 2026-07-07: the fold is now ONLY Project.foldList — server/domain/project.ts removed. The Effect migration changed fold-version generation and lockstep, so rereview `scripts/fold-version.ts` and `test/architecture/fold-version-lockstep.test.ts`. Branded scalars + the opaque `Project` and its canonical statics `fromCreated` / `applyEvent` / `foldList`. *This fold is the single source of truth reused by server and clients alike.* Also drives **`FOLD_VERSIONS`** — a per-projection map (name → build-time SHA-256 of that projection's fold nodes; `projects` hashes the `Project` class), generated into `packages/contracts/fold-version.generated.ts` by `scripts/fold-version.ts` (`npm run gen:fold-version`). The server stamps `FOLD_VERSIONS.projects` on the persisted `projection_state` row; a mismatch forces a from-zero rebuild. It changes automatically when the fold changes — no manual bump (pinned by `test/architecture/fold-version-lockstep.test.ts`).
DONE 2. `events/meta.ts` — tiny `withMeta()` helper that gives every event a common envelope.
DONE 3. `events/project.ts` — the 7 event variants (Created/Renamed/DirectoryChanged/Archived/Restored/MetadataChanged/Deleted).
DONE 4. `events/domain-event.ts` → `events/domain.ts` — the internal module constructs the `DomainEvent` union and JSON codec once; the public module constructs `SequencedEvent {seq, event}` and re-exports those exact schema identities. The helper subpath is explicitly blocked from the source and staged package exports.
DONE 5. `rpc.ts` — the `ExpandRpcs` group + tagged errors. Focus on Protocol v2: `ProjectList → {projects, seq}` and the `stream:true` `Events`/`Connect` RPCs with `fromSeq`.
DONE 6. `endpoint.ts` — discovery-file schema + `PROTOCOL_VERSION = 2` (I-3).
UPDATED 7. `app-context.ts` — the pure path derivation contract: `defaultDataDir(path, homeDir, channel)` chooses the channel home, `makeAppContext(path, { homeDir, cwd, dataDir, channel })` derives every runtime path from explicit inputs, and every root now owns its local `server.json.lock`. The required `AppContext` `Context.Service` has no ambient default. Application-owned Node adapters acquire home, cwd, and arguments before providing the service.
DONE 8. `apps/cli/cli/contract/envelope.ts` — the stable `expand/v1` JSON envelopes the CLI prints; the former contracts-owned `cli.ts` path was deleted.

**Scrutinize hardest:**
- **Single fold, no second copy.** Confirm `foldList`/`applyEvent` here are genuinely the *only* projection and that server + client-ts reuse them (any divergence breaks snapshot-vs-replay consistency).
- **`applyEvent` semantics:** `MetadataChanged` is a partial patch keyed on `!== undefined` (omission keeps a field; `null` clears it). Tags dedupe via `new Set`. Check `undefined` vs `null` intent.
- **`foldList` replay-safety:** create is idempotent, delete tombstones, unknown ids are no-ops — must match how the server sequences and the client gates by `seq`.
- **Validation bounds are the system trust boundary:** name/tag regex, UUIDv4 ids, description ≤ 2048, directory ≤ 4096 — the *same* limits must apply on both the event and RPC schemas.
- **`PROTOCOL_VERSION` coupling:** any shape change must bump the version (clients reject mismatches).
- **Published schema identity:** `events/domain.ts` must retain the emitted `./domain-event.js` specifier, strict identity with the internal schemas, and `ERR_PACKAGE_PATH_NOT_EXPORTED` for direct helper imports.
- **Path coherence and host acquisition:** `AppContext` remains pure derivation over supplied values. Application host roots acquire cwd, home, and argv and provide them; contracts code must not read ambient Node state. An explicit data directory must change `dataDir`, `dbPath`, `endpointFile`, and `logDir` together; omitting it must preserve the channel-specific default.

**Best tests to read:** `test/project-fold.test.ts` (the projection), `test/events.test.ts` (round-trips + legacy decode), `test/rpc.test.ts` (validation at the RPC boundary), and `packages/contracts/test/app-context.test.ts` (default-vs-explicit path derivation).

---

### Stage 2 — `apps/server`  ·  75–90 min  ·  🔴 high

**What:** The authoritative backend for one selected state root (I-2). An event-sourced service: mutations append immutable events to a SQLite log (monotonic `seq`); the read-model is an **in-memory live projection seeded at boot from a persisted snapshot** (folded from the log only for the tail since that snapshot, or from zero on first boot / `FOLD_VERSIONS.projects` mismatch), and it's all served over a token-guarded, loopback-only WebSocket RPC. It owns the root through `backend.lock`, writes that root's endpoint file on boot (I-3), and self-shuts-down at zero connections for the root (I-4).

**Why here:** It depends only on `contracts`, and it's the source of truth every client mirrors. Understand it before any client.

**Read in order:**
DONE 1. `packages/contracts/events/project.ts` — refresh the event vocabulary the backend stores.
DONE 2. `db/event-store.ts` — the BASE: the append-only `events` table DDL plus the raw primitives (`append`, and the keyset-paginated streaming `scan` whose undecodable rows are **defects** carrying `{seq, stream_id, event_type}`). The primitives are NOT a service: `specializeEventStore(build)` is the only door — it hands them to a specialization builder as a closure, so raw `scan`/`append` cannot be summoned from context anywhere (see the specialization ADR, 2026-07-05). Chunk granularity comes from the `EventScanChunkSize` reference (default 1000). Then the two specializations: `db/replay-feed.ts` — `ReplayFeed.read(fromSeq)`, the unfiltered seq-ordered feed the RPC backlog replays — and `application/projects/project-event-store.ts` — `ProjectEventStore.read(fromSeq)` (tag filter derived from the `ProjectEvent` union) and `append(event)`, which derives `stream_id` from `event.projectId` so a mismatched stream id is unrepresentable.
DONE 3. `db/projection-state-store.ts` + `application/projections.ts` — the read-model cache. `projection-state-store.ts` is the name-keyed `projection_state {name, state, last_seq, fold_version}` table (`load` returns `null` on absent/NULL-state; `save` upserts state+cursor in ONE row — the persisted mirror of the C2 pair). `projections.ts` boot-catches-up via streamed folds (`ProjectEventStore.read`), then keeps checkpointing: a scoped debounce fiber (500ms quiet) plus a shutdown finalizer registered BEFORE the fiber so teardown interrupts-then-writes. `list`/`snapshot` read the `SubscriptionRef`; `apply` advances it with the C2 seq-gate.
DONE 4. `application/event-bus.ts` — in-memory `PubSub` of `SequencedEvent` (the live half of the stream).
DONE 5. `application/projects/use-cases.ts` — **the busiest, riskiest file.** Every mutation, the `Semaphore(1)` mutex, directory validation, and the uninterruptible `commit` (**append via `ProjectEventStore` → `projection.apply` (advance the in-memory model) → publish** — `commit(event)` takes only the event; the stream id derives inside the facade).
DONE 6. `runtime/connection-tracker.ts` — the `Ref(count)` + armed-flag + `Deferred` state machine for I-4.
DONE 7. `rpc/handlers.ts` + `rpc/guard.ts` — binds the contract to use-cases through the named Effect error boundary. The guard changed to classify SQL, Schema, and Platform errors as defects while allowing only declared errors across the wire. The `fromSeq` replay logic itself lives in `apps/server/rpc/stream.ts` (composed here via `...streamHandlers`).
DONE 8. `transport/http-server.ts` — WebSocket transport: `timingSafeEqual` token check, loopback bind, access log that strips the token.
DONE 9. `runtime/state-root-lock.ts` — the hardened runtime ownership machinery. Historical review note (2026-07-13): the pre-migration ownership hardening was reviewed; re-review the Effect migration. Raw root acquisition rejects a live owner immediately; startup gives an endpoint-absent owner the bounded four-second shutdown handoff. Dead-owner reclaim and release require unchanged PID/token/inode evidence, invalid or changing evidence fails closed, and distinct roots remain independent.
DONE 10. `composition/app.ts` → `main.ts` — lifecycle orchestration and the thin entrypoint. Historical review note (2026-07-13): the pre-migration orchestration and filesystem modes were reviewed; re-review the Effect migration. `main.ts` acquires the startup-aware scoped `backend.lock` lease before the file logger, database, or `AppLayer` is built. It sets `process.umask(0o077)` before anything touches the filesystem, while `app.ts` fail-closed-`chmod`s the data dir (`0700`), SQLite log (`0600`), and WAL/SHM sidecars if present (`secureIfPresent`).

**Scrutinize hardest:**
- **Effect platform boundaries:** filesystem, path, process, clock, crypto, and transport work uses Effect platform services or exact registered adapters. Recoverable external failures remain typed; impossible states are deliberate defects. Every release path preserves the complete cleanup `Cause` rather than flattening failure, defect, or interruption.
- **Concurrency:** the single `Semaphore(1)` is the *only* thing serializing read-validate-commit. Confirm every mutating use-case goes through it and uniqueness/"exactly-one-winner" guards can't be bypassed.
- **`fromSeq` replay seam** (`apps/server/rpc/stream.ts`, composed into `rpc/handlers.ts`): subscribe → read backlog → filter live by `seq > lastReplayed`. Verify **no gap or duplicate** between backlog tail and first live event under concurrent appends. The backlog is now STREAMED (`ReplayFeed.read`), so `lastReplayed` is a `Ref` initialized to `fromSeq` and advanced as the backlog flows; the live filter reads it only after `Stream.concat` switches over.
- **`commit()`:** append (SQLite) + publish (PubSub) are two systems wrapped in `uninterruptible`. A failure between them desyncs bus from log — confirm "log is source of truth, bus is best-effort" is intended.
- **Fail-fast decode:** `scan` dies on any undecodable row (defect names seq/stream_id/event_type). This deliberately REVERSES the earlier skip-with-warning trade-off (ADR 2026-07-05): silently-vanishing projects were judged worse than a refusing boot. Verify the defect carries enough context to act on, and that no caller re-introduces a silent skip.
- **The read-model cache:** confirm the four guards that keep the persisted state equal to a replay — (1) checkpoints are written only by the projection's own scope (boot save, the debounce fiber reading consistent C2 pairs, and the shutdown finalizer — commit path writes NOTHING to projection_state), (2) each row is stamped at the state's own `seq`, (3) tail catch-up and from-zero rebuild both go through the same shared fold, and (4) a `FOLD_VERSIONS.projects` mismatch forces a from-zero rebuild. Also verify the finalizer-before-fiber registration order (teardown must interrupt the fiber BEFORE the final write).
- **State-root ownership** (`runtime/state-root-lock.ts` + `main.ts`): I-1 confines construction statically, but `backend.lock` is the runtime singleton. Trace default-root migration coordination through the external guard, default-root spawning through the external spawn lock, and explicit non-default roots through the root-local lock. Confirm an advertised live owner rejects promptly, an endpoint-absent live owner gets only a bounded startup/shutdown handoff with no overlapping lease, a stale endpoint without a live owner remains replaceable, distinct roots coexist, stale reclaim and release verify unchanged PID/token/inode evidence, malformed evidence fails closed without retry, and a stale finalizer cannot delete a replacement lease.
- **HTTP/core teardown and exact identity:** the HTTP transport gets a bounded graceful close, but the separately owned core scope must close even when HTTP teardown fails, times out, defects, or is interrupted. Directory validation compares exact filesystem identity, including symlink aliases, before a project is committed.
- **On-disk secrecy** (`main.ts` + `composition/app.ts`): the endpoint file carries the loopback auth token and the SQLite log carries every event, so both must stay group/world-unreadable. `umask(0o077)` narrows the default creation mode and the fail-closed `chmod`s tighten anything already on disk. Confirm the `umask` is set *before* any file is created (it runs before the runtime boots), and that `secureIfPresent` genuinely narrows the WAL/SHM sidecars once they exist rather than silently skipping them.

**Best tests to read:** `test/integration/state-root-lock.test.ts`, `test/integration/concurrency.test.ts`, `test/integration/events-replay.test.ts`, `test/integration/durability-restart.test.ts` (snapshot advances across a restart; the checkpoint-write cadence itself is pinned by the checkpoint-cadence tests in `projection.test.ts`), `test/integration/trust-boundary.test.ts`, `test/integration/snapshot-equivalence.test.ts` (the proof that state@k+tail == fold-from-zero), `test/integration/projection-state-store.test.ts`, `test/integration/project-event-store.test.ts`, `test/integration/replay-feed.test.ts`, the boot-matrix + checkpoint-cadence tests in `test/integration/projection.test.ts`, `apps/server/test/unit/rpc-guard.test.ts`, and `test/integration/events-handler.test.ts` (the streamed-backlog dedup gate).

---

### Stage 3 — `packages/client-ts`  ·  75–90 min  ·  🔴 high

**What:** The "connection brain" shared by all three frontends: a Node platform seam, per-root find-or-spawn discovery, the reconnecting `ClientSession`, and session-backed typed facades. Applications own their state, with the framework-neutral controller from `@expand/contracts/project-sync` handling list/replay synchronization for long-lived UIs. Hosts no `AppLayer` (I-2); reaches the selected root's backend only via its discovery file (I-3) and never imports `apps/server` (I-1). Its public API is a **curated, Effect-native SDK surface**: external code enters *only* through the scoped entrypoints — `@expand/client-ts` (connection core), `@expand/client-ts/project`, `@expand/client-ts/server`, and `@expand/client-ts/adapters/node`. Package exports and the `client-ts-barrel-only` dependency-cruiser rule make internals unreachable from outside; only selected modules and symbols carry `@internal` TSDoc.

**Why here:** Depends on contracts and Effect/platform packages; interoperates with and may launch the separately built server through the backend-command seam, without importing apps/server. It is consumed by every frontend. Connection and reconnect behavior is centralized here, while the later frontend chapters show how each application owns its state and lifecycle.

**Read in order:** *(public entrypoints = `index.ts`/`project/index.ts`/`server/index.ts` + `adapters/node.ts`; everything else is package-internal)*
DONE 1. `ARCHITECTURE.md` — **read first**, the author's own line-referenced walkthrough. Its "Public API surface" section is the map of what each entrypoint (root, `/project`, `/server`, `adapters/*`) exports and what is `@internal`.
DONE 2. `index.ts` + `project/index.ts` + `server/index.ts` — the public entrypoints: root = strict connection core; the domain surfaces live on the `/project` and `/server` subpaths (one canonical import path per symbol).
DONE 3. `adapter.ts` — the 2-member `RuntimeAdapter` platform seam. Historical review note (2026-07-12): the pre-migration seam and selected-root propagation were reviewed; re-review the Effect migration. Its `spawnBackend(dataDir)` receives the selected state root while endpoint discovery separately confirms readiness.
DONE 4. `discovery.ts` + `spawn.ts` + `spawn-lock.ts` — Historical review note (2026-07-13): pre-migration discovery and lock convergence were reviewed; re-review the Effect migration. `discovery.ts` validates the selected root's endpoint and owning PID; `spawn.ts` owns find-or-spawn and the **30-second** endpoint-advertisement deadline; `spawn-lock.ts` owns atomic lease publication plus token/inode-safe dead-owner recovery and release. Same-root callers converge, while distinct roots remain independent.
DONE 5. `rpc-client.ts` — `acquireClient`: builds the protocol layer, the presence handshake, stale-endpoint self-healing retry.
DONE 6. `adapters/node.ts` — the sole platform implementation (socket + spawn); the platform subpath entrypoint (public alongside `/project` and `/server`).
DONE 7. `client-session.ts` — the reconnect loop, per-transport-attempt lifecycle, connection status, active epoch, and scope teardown.
DONE 8. `supervise.ts` — logs a background fiber's death unless it was a clean interrupt.
UPDATED 9. `project/client.ts` + the package-root `client-layer.ts` — the session-backed facades and how layers share one session. The current hunk is intended to be comment/whitespace-only; verify exported types and service identity are unchanged.

**Scrutinize hardest:**
- **Process boundary:** `ProcessServices` and Effect `ChildProcess` own process probing and backend launch. `adapters/node.ts` must not regain direct ambient process or child-process control, and interruption must not leak a pre-acquisition child.
- **Project synchronization** (`packages/contracts/project-sync.ts`): each reconnect is a distinct epoch; stale work cannot publish into the current epoch, and every session/synchronization cleanup path preserves the complete `Cause`. List first, publish `{projects, seq}` atomically, then replay `Events({ fromSeq: seq })`; stale sequences are ignored and fresh reconnect lists replace retained state. A list or Events failure, or clean Events completion, publishes reconnecting and retries a complete list/replay epoch with capped backoff; status-stream failure remains owner-visible.
- **Spawn convergence** (`spawn.ts` + `spawn-lock.ts`): election retry after a failed selected spawner stays under the original single deadline; it must not restart a fresh timeout. A valid live owner remains contended regardless of age; dead current or tokenless legacy owners are reclaimed only through exact record/inode evidence; malformed or changing evidence remains untouched; and release removes only its own lease. Concurrent callers on one root must spawn once, callers on distinct roots must proceed independently, and the server's `backend.lock` still enforces lifetime uniqueness.
- **Startup timing:** the client must still be pending at twenty-nine seconds, accept a valid endpoint advertised after six seconds, and fail deterministically at thirty seconds. The TestClock tests synchronize on a post-spawn filesystem poll before advancing virtual time so they cannot pass or fail through scheduler luck.
- **Data-directory propagation:** discovery, the derived spawn-lock path, endpoint polling, and the adapter's backend argv must all come from the same normalized `AppContext`; mixing the default endpoint with an explicitly selected database would create two independent backends.
- **Reconnect classification and cleanup** (`client-session.ts`): `Cause.hasInterruptsOnly` must separate deliberate shutdown from a dropped socket, and the current epoch must be invalidated before `"reconnecting"` is published.
- **Non-optimistic state:** typed facade mutations only call RPC; desktop and TUI state changes only through fresh lists and sequenced events.
- **Entrypoint boundary** (`index.ts`/`project/index.ts`/`server/index.ts` + package exports + the `client-ts-barrel-only` rule): external code must reach the package only via the entrypoints; internals are unreachable from outside, and only selected modules and symbols carry `@internal` TSDoc. Confirm the rule is non-vacuous (it flags a real deep import) and note its one blind spot — depcruise excludes `test/`, so the rule does not police test files (all current out-of-package tests go through the public entrypoints; client-ts's own tests deliberately deep-import internals relatively).

**Best tests to read:** `packages/contracts/test/project-sync.test.ts` (atomic snapshots, replay, sequence gating, interruption, and fresh-list replacement), `packages/client-ts/test/integration/client-session.test.ts`, `packages/client-ts/test/integration/project-sync.test.ts`, `packages/client-ts/test/integration/find-or-spawn.test.ts` (same-root convergence, distinct-root independence, stale locks, and the six-/thirty-second deadline), `test/architecture/client-ts-barrel.test.ts` (the public-API boundary), and `packages/client-ts/test/unit/entrypoints.test.ts` (pins the `/project` + `/server` surfaces and the strict-core root).

**Dogfood the public surface — `examples/client-ts/`:** three runnable real-world programs written as an *external consumer* would — `bootstrap-projects.ts` (create a project per subfolder, deduping/skipping conflicts), `archive-stale.ts` (archive projects whose directory has vanished), and `audit-log.ts` (tail `ProjectClient.events` to a JSONL file across session epochs). Every import comes only from the public entrypoints (`@expand/client-ts`, `@expand/client-ts/project`, `@expand/client-ts/adapters/node`) — the `client-ts-barrel-only` rule (Stage 7) covers this directory, so a deep import into a package internal fails CI, and each example has a subprocess smoke test in `examples/client-ts/test/` that runs it against an isolated backend. Read `examples/client-ts/ERGONOMICS.md` for the preserved dogfooding findings and the migration notes for removed store-specific friction.

---

### Stage 4 — `apps/cli`  ·  30–45 min  ·  🟢 low

**What:** A thin, agent-friendly CLI that turns shell verbs into typed RPC calls and prints stable, versioned JSON envelopes (`apiVersion "expand/v1"`) with distinct per-error exit codes. It also owns the parsed global `--data-dir` surface used to isolate the CLI and the backend it spawns. Holds no business logic.

**Why here:** It's the **simplest complete frontend** — review it first among the UIs to see the full `frontend → client-ts → RPC → backend` loop without any UI complexity.

**Read in order:**
DONE (2026-07-12) 1. `cli/runtime/app-context-layer.ts` + `cli/main.ts` — the parsed `DataDir` setting becomes an `AppContext` layer before the composition root provides the real Node client; `main.ts` then builds the command tree and installs the JSON error formatter (`makeExpand` factory + main-module guard).
DONE 2. `cli/commands/define-command.ts` — the `defineCommand` seam every verb flows through (envelope/text/quiet rendering).
DONE (2026-07-12) 3. `cli/output.ts` + `cli/commands/global-flags.ts` — stdout/stderr discipline and the `--format`/`--quiet` flags plus `DataDir`, a true global directory flag accepted before or after any subcommand and allowed to name a not-yet-created directory.
UPDATED (2026-07-31) 4. `cli/contract/version.ts` + `cli/contract/envelope.ts` + `cli/contract/project/envelope.ts` + `cli/contract/server/envelope.ts` — `version.ts` owns `ENVELOPE_VERSION`, `contract/envelope.ts` constructs generic versioned envelopes, and the project and server modules own their domain success-envelope schemas. Then follow the focused error-contract path below.
UPDATED 5. `cli/commands/project/create.ts` — a representative command (the pattern all verbs follow). Its current hunk must remain comment-only.
UPDATED 6. `cli/commands/project/resolve-project-target.ts` — name-or-UUID target resolution. Its current hunk must remain comment-only.
UPDATED (2026-07-31) 7. `cli/errors/index.ts` + `cli/errors/render-errors.ts` — the aggregate contract/parser-error → CLI-error boundary and final stderr rendering. Read these after the focused path so the project → server → unexpected precedence and definition-derived exit behavior are already familiar. Parser failures such as an existing file passed to `--data-dir` must still produce one structured `INVALID_ARGUMENT` envelope and exit 2.

**New error-contract mechanism — focused reading path (~20 min):**
1. `cli/contract/error/definition.ts` — the small `ErrorDefinition` contract. This is the shared shape for one machine-readable error: `code`, `exitCode`, and `retryable`.
2. `cli/contract/usage/errors.ts` → `cli/contract/project/errors.ts` → `cli/contract/server/errors.ts` → `cli/contract/system/errors.ts` — the domain-owned definition records. These are the only production owners of the raw codes, exit statuses, and retryability flags.
3. `cli/contract/error/catalog.ts` — combines the domain records into the canonical catalog and derives the `ErrorCode` type and schema. Check that it aggregates definitions without copying their metadata.
4. `cli/contract/error/envelope.ts` — defines the stable error-envelope schema and `makeErrorEnvelope()`, which receives a selected definition instead of separate raw metadata.
5. `cli/errors/usage/parser-errors.ts` — translates Effect CLI parser tags into usage definitions and formats parser failures with the same envelope builder.
6. `cli/errors/project/errors.ts` → `cli/errors/server/errors.ts` → `cli/errors/system/unexpected.ts` — the runtime adapters. Presentation data (`message`, `input`, and `hint`) stays near the domain error class, while machine metadata and the Effect exit code come from its static definition.
7. `cli/errors/project/map-error.ts` → `cli/errors/server/map-error.ts` → `cli/errors/index.ts` — maps RPC/transport failures into those adapters, then applies the required project → server → unexpected fallback order.
8. `cli/errors/render-errors.ts` — the final process boundary: it selects the definition for direct parser errors, writes one JSON line to stderr, and returns the definition-derived exit status.

The complete flow to hold in mind is: **source error → domain mapper → runtime adapter → static definition → `makeErrorEnvelope()` → stderr and process exit**. The definition is the single source of truth for machine behavior; the runtime adapter is the single source of truth for human-facing presentation.

**Scrutinize hardest:**
- **Effect CLI boundary:** the runner uses `Command.run` and provides `CliOutput.layer(jsonCliErrorFormatter)` with `ProcessServices.layer`; `Path` resolves the backend command, while `Console` owns stdout/stderr. Typed CLI failures render through one top-level mapping without changing the stable `expand/v1` envelope or stdout/stderr contract.
- **Single metadata owner:** each code, exit status, and retryability flag must appear in exactly one domain definition record. The catalog, envelopes, adapters, and renderer must derive from that record rather than restating literals.
- **Error-mapping fidelity:** unmapped `_tag`s deliberately fall through to `UNEXPECTED` (exit 1) — verify the project and server switch tables cover the real contract error set and that `cli/errors/index.ts` preserves project → server → unexpected precedence.
- **Exit codes are an external API** for scripting agents — confirm codes (1/2/5/6/7/8/9/10) and `retryable` flags are stable and tested.
- **stdout/stderr purity:** a failure must emit nothing on stdout and exactly one JSON line on stderr.
- **Presentation compatibility:** messages, hints, and input objects remain runtime-adapter data. Exact-envelope tests must pin those values while `code`, `exitCode`, and `retryable` continue to come from the associated definition.
- **Envelope construction is centralized:** `cli/contract/error/envelope.ts` is the only error-envelope builder. The schema snapshot and contract tests guard the stable `expand/v1` shape and accepted ten-code set.
- **Folder ownership is enforced:** the retired flat files (`error-code.ts`, `envelope.ts`, `parser-errors.ts`, `project-errors.ts`, and `server-errors.ts`) must stay absent; the architecture test pins the domain layout and prevents compatibility aliases from returning.
- **Global data-dir semantics:** help must expose the flag at root and child levels; before/after-subcommand positions must resolve identically; existing and absent directories must work; an existing file must fail before a handler runs; omission must retain the channel default.

**Best tests to read:** `test/unit/error-catalog.test.ts` (exact ten-definition matrix, uniqueness, and derived type/schema), `test/unit/parser-errors.test.ts` (all parser tags and direct `UNKNOWN_COMMAND` coverage), `test/unit/errors.test.ts` (every project/server/system mapping with exact complete envelopes and exits), `test/unit/render-errors.test.ts` (stderr and exit behavior), `test/unit/envelope-schema.test.ts` + `test/contract/envelope.test.ts` (wire shape), and the repository-level `test/architecture/app-folder-convention.test.ts` (required domain files and retired-path absence). Keep `test/contract/contract.test.ts` and `test/unit/global-flags.test.ts` for the broader CLI and global data-directory behavior.

---

### Stage 5 — Terminal UI: `packages/ink-input` → `apps/tui`  ·  60–85 min

Read the input framework first, then the TUI that consumes it.

#### 5a — `packages/ink-input`  ·  20–30 min  ·  🟢 low

**What:** A small, ink-agnostic input framework. It exists to defeat a structural flaw in Ink: its `useInput` is a global broadcast with no consumption or priority, so exclusive routing requires that *exactly one* handler exist. The package provides that single router plus pure helpers (key normalization, first-match binding resolution, text-field semantics) and contains **zero app policy**.

**Read in order:** `HOW-IT-WORKS.md` (first) → `key-name.ts` (canonical key names) → `bindings.ts` (`resolveBinding`, first-match-wins) → `text-field.ts` (the paste-vs-keypress rule + code-point-safe editing) → `use-key-router-ink.tsx` (the one `useInput`) → `components/hint-bar-ink.tsx`.

**Scrutinize hardest:** the **single-router invariant** (one `useInput` repo-wide, pinned by an arch test); the `textFieldConsumes` rule `input.length>0 && keyName===input` (so a pasted literal `"return"` is text but a real Enter falls through); and that the *same* binding table drives both routing and the hint bar, so help can never drift from behavior.

**Best tests:** `test/text-field.test.ts`, `test/key-name.test.ts`, and `test/architecture/tui-input-boundary.test.ts`.

#### 5b — `apps/tui`  ·  40–55 min  ·  🟡 medium

**What:** The Ink terminal frontend — a one-screen project manager driven by a **pure unidirectional pipeline**: `useKeyRouter → route() (pure) → uiReduce() (pure) → runEffect (the single impure seam) → ProjectClient`, with synchronized projects held in React state.

**Why here:** Depends on `contracts` + `client-ts` + `ink-input`.

**Read in order:** `runtime/tui-runtime.ts` (client-only `ManagedRuntime`) → `main.tsx` → `input/state.ts` (the vocabulary) → `input/bindings.ts` → `input/route.ts` (modal top-down, text first-refusal) → `input/reduce.ts` (state transitions + `DomainEffect` data + `reconcile()`) → `features/projects/use-projects.ts` (the Effect↔React bridge) → `runtime/effect-runner.ts` (runner-owned fibers and callback observation) → `components/app.tsx` (the only stateful component, holds `runEffect`) → `components/project-list.tsx`.

**Scrutinize hardest:**
- **Owned Effect lifecycle:** the TUI root owns its runtime, synchronization fiber, and mutation fibers; teardown interrupts and observes them. Routing, reducers, binding selection, and reconciliation remain pure ordinary functions.
- **C1 fix:** `route()` can *never* turn a typed command-letter (`a`, `d`, …) into a command while typing. The create/overlay branches must reach no command lookup.
- **`reconcile()` selection math** under concurrent mutations (clamping, vanished selection, empty list, overlay auto-close) — off-by-one here is a silent data/UX hazard.
- **`submitOverlay`:** empty rename/dir is a keep-open no-op, but empty metadata description *deliberately clears* to null (C8) — confirm intent vs. accidental data loss.

**Best tests to read:** `test/unit/route.test.ts` (C1 at the routing layer), `test/unit/reduce.test.ts` (effects + reconcile races), `test/ui/app-input-routing.test.tsx` (end-to-end C1), and `apps/tui/test/ui/use-projects.test.tsx` (runner-owned fibers and callback observation).

---

### Stage 6 — Desktop: `packages/electron-ipc` → `desktop-main` → `desktop-renderer`  ·  ~3–4 hrs

Read the IPC framework, then the privileged main process, then the renderer. This is where I-1 is most aggressively defended.

#### 6a — `packages/electron-ipc`  ·  75–90 min  ·  🔴 high

**What:** A typed, contract-driven IPC framework. The main process is the trust boundary; raw Electron IPC primitives are confined to **two adapter files**. In production the renderer never imports `apps/server` and reaches the backend only through a transferred `MessagePort` handed over by this framework.

**Read in order:** `contract.ts` (the pure DSL — channel kinds, wire names, result envelopes, type derivations) → `main.ts` (the 5-step security pipeline + `bindIpc`) → `renderer.ts` (the Effect client) → `preload.ts` (the small auditable bridge) → `main-electron.ts` + `preload-electron.ts` (the only files importing `electron`) → `apps/desktop/src/shared/ipc/channels.ts` (the real contract — a *single* `portExchange` channel).

**Scrutinize hardest:**
- **Scoped IPC and nonce ownership:** binding owns supervised callback fibers and registrations; preload owns static subscriptions; renderer port exchange uses Effect `Crypto` nonce generation. Host-required Promise signatures translate immediately at the exact adapter, and release preserves cleanup `Cause`.
- **Sender validation** (`main.ts`): the main-frame check relies on **object identity** (`frame === target.mainFrame`); confirm `toFrameLike` preserves reference equality and that `exactOrigin` can never match the literal `'null'` opaque origin.
- **Defect sanitization:** handler/encode failures must collapse to `{_tag:'IpcDefect', message:'internal error'}` — no internal error text leaks across the bridge.
- **`portExchange` trust:** the port crosses via `window.postMessage`; on `file://` the origin falls back to `'*'`, so the load-bearing guards become `source === win` + channel + nonce in the renderer. Check all three, on every path (success/throw/timeout).
- **`payloadSize` fail-closed:** `JSON.stringify` returning `undefined` or throwing must both count as oversized.

**Best tests:** `test/validate-sender.test.ts`, `test/bind-ipc.test.ts` (full pipeline + defect hiding), `test/renderer.test.ts`.

#### 6b — `apps/desktop` (main process)  ·  45–60 min  ·  🔴 high

**What:** The privileged half of the desktop app — Electron **main** + preload + the shared IPC registry. On window creation it builds a `ManagedRuntime` hosting `ClientSession`, `ProjectClient`, and `ServerClient` (so **main is a client, not a server** — I-2), mints a fresh `MessageChannelMain` per `rpcPort` request, and runs a full Effect `RpcServer` (the same `ExpandRpcs` contract) on the main side of the port. Applies the renderer-hardening security pipeline.

**Read in order:** `src/shared/ipc/channels.ts` → `src/preload/index.ts` → `src/main/runtime/client-runtime.ts` (proves main is a client and inherits raw `--data-dir` through `AppContext`) → `src/main/application/main-program.ts` (main lifecycle program; matching test: `test/unit/main-program.test.ts`) → `src/main/index.ts` (the wiring hub: CSP, hardened `webPreferences`, navigation denial, `rpcPort` handler) → `src/main/rpc/server.ts` (`makePortProtocol` adapts `MessagePortMain` into an `RpcServer.Protocol`) → `src/main/rpc/transport.ts` → `src/main/rpc/handlers.ts` → `src/main/rpc/project-handlers.ts` (the proxy logic) → `src/main/rpc/connection-handlers.ts` (Connect status mirror + Events `fromSeq` gating) → `src/main/security/window-options.ts` + `ipc/origin-rules.ts` + `ipc/port-lifecycle.ts`.

**Scrutinize hardest:**
- **Packaged identity and admission:** production load URL, navigation admission, IPC sender admission, and renderer identity resolve to one exact canonical packaged file, including symlink-safe identity checks.
- **Security pipeline completeness:** CSP only in prod, the `sandbox`/`contextIsolation`/`nodeIntegration` pin, navigation/window-open denial, and — load-bearing — that the dev `exactOrigin` carve-out can **never** reach a production build (prod is `file://`-only).
- **Runtime selection:** Electron's raw `--data-dir` must reach the main-process `AppContext` and then the Node adapter's spawned backend argv.
- **Port lifecycle and supervised callbacks:** MessagePort/RPC scopes own listeners, queues, protocols, fibers, and close; supersession (tear down the old port before minting a new one) and reload/close must interrupt stale port fibers, or you get hung requests / request-id collisions.
- **Error translation:** every client call rethrows `RpcClientError` as a *defect* (`Effect.die`), Health dies on disconnect — confirm no unsanitized backend message reaches the renderer.

**Best tests:** `test/integration/rpc-server.test.ts` (full round-trip), `test/integration/connection-honesty.test.ts`, `test/unit/origin-rules.test.ts`, `test/unit/port-lifecycle.test.ts`.

#### 6c — `apps/desktop` (renderer)  ·  75–90 min  ·  🔴 high

**What:** The React + TanStack Router UI. All backend access flows over the single `MessagePort` (I-1): a port-backed `RpcClient`, a thin project facade, the framework-neutral sync controller, and renderer-owned Zustand state. React reads the Zustand store and never owns the connection lifecycle.

**Read in order:** `rpc/renderer-port.ts` → `rpc/transport.ts` (the port-backed protocol — the heart of the seam) → `rpc/project-rpc.ts` → `features/projects/data/project-store.ts` (the renderer-owned Zustand state and project-sync sink) → `features/projects/data/project-context.tsx` (the React bridge) → `app/runtime.ts` (nonce-correlated port acquisition, scoped synchronization, first-snapshot gate, and 10s timeout) → `app/root.tsx` (matching test: `test/unit/renderer-root.test.tsx`) → `app/runner.ts` (matching test: `test/unit/renderer-runner.test.ts`) → `main.tsx` → `features/projects/data/use-projects.ts` → `features/command/components/CommandPalette.tsx` → `features/projects/pages/ProjectsView.tsx`.

**Scrutinize hardest:**
- **Renderer ownership:** preload/renderer unload closes the root scope, port, synchronization, and owned mutation callback fibers. Late callback completion cannot update an unloaded renderer, and defects or cleanup Causes remain observable.
- **Bootstrap and reconnect:** the controller lists, subscribes from the returned sequence, ignores stale replay, and replaces the renderer snapshot with a fresh list after reconnect.
- **MessagePort seam integrity (I-1):** renderer code reaches the backend *only* via the port; `window.expand` is the only bridge.
- **Inbound decode trust** (`transport.ts`): `parser.decode(event.data)` is cast to the message type with no validation — a hostile message on the port is assumed well-typed. Assess.
- **Effect/React lifecycle:** `boot` forks `runProjectSync` in its scope, races the first snapshot against early fiber completion, mounts only after that snapshot, and then joins and supervises the synchronization fiber; verify the boot scope owns and interrupts synchronization and observes status-stream failure.

> ⚠️ **Test-tree gotcha:** several files under `apps/desktop/test` (`connection-honesty`, `transport`, `rpc-server`, `window-options`, `harden-web-contents`, `origin-rules`, `port-lifecycle`, `backend-entry`) actually exercise the **main** process (Stage 6b), not the renderer — don't attribute their coverage to renderer code.

**Best tests:** `test/integration/project-reconnect-sync.test.ts` (list/replay and fresh-list replacement through the MessagePort), `test/unit/project-store.test.ts` (independent Zustand state and atomic snapshots), `test/unit/project-context.test.tsx` (React updates and non-optimistic mutations), `test/unit/renderer-boot-port.test.ts` (the I-1 handshake), and `e2e/set-metadata.spec.ts` (full Playwright round-trip).

---

### Stage 7 — Enforcement & infra  ·  105–135 min

The capstone: how the invariants you've been tracking are *mechanically* guaranteed. Reviewing this last lets you judge whether the tests actually pin what the earlier stages claimed.

#### 7a — `test/architecture`  ·  45–60 min  ·  🟡 medium

**What:** The architecture suite turns the prose invariants and Effect-only policy into build failures. Dependency-cruiser checks are combined with filesystem, source analysis, diagnostics, and certification assertions; CODEOWNERS and policy-link checks prevent quiet relaxation. Avoid relying on a fixed test count: this suite is intentionally cumulative.

**Read in order:** `docs/architecture/BOUNDARIES.md` → `docs/architecture/EFFECT_ONLY.md` → `.dependency-cruiser.cjs` → `test/architecture/effect-policy.test.ts` → `test/architecture/effect-final-ratchet.test.ts` → `test/architecture/effect-version-lockstep.test.ts` → the invariant-specific architecture tests → `test/architecture/no-dead-code.test.ts`.

**Mandatory gates and the regressions they prevent:**
- `test/architecture/effect-policy.test.ts` pins the objective local gates, exact policy text, and every I-1 through I-4 policy link; human review handles diff-specific Effect adoption judgments.
- `test/architecture/effect-final-ratchet.test.ts` rejects the migration baseline, updater, broad exemption, and inline-disable machinery; it prevents permanent policy from silently reverting to accepted debt.
- `test/architecture/effect-version-lockstep.test.ts` pins all Effect ecosystem versions; it prevents incompatible diagnostics, runtime, or platform packages from drifting independently.

**Scrutinize hardest:**
- **Semantic non-vacuity:** introduce representative forbidden constructs mentally against the analyzer tests and confirm aliases, nested callbacks, and source consumers cannot evade the rule.
- **Policy completeness:** reconcile the complete I-1 through I-4 map in `docs/architecture/BOUNDARIES.md`; every documented enforcement path must exist and manual review must retain the Effect-specific contract.
- **Hardcoded path safety:** renamed files and newly tracked sources must fail coverage rather than quietly weaken a list or exclusion.
- **Existing invariants:** preserve the dependency-cruiser, package-manager, Node-only, frontend isolation, IPC, TUI router, backend ownership, fold lockstep, colocation, and Knip guarantees alongside the Effect gates.

**Best commands:** `npm run lint`, `npm run typecheck:all`, `npm run arch`, and `npm run knip`.

#### 7b — Infra & module ordering  ·  60–75 min  ·  🟡 medium

**What:** The build/CI/enforcement plumbing makes the architecture checkable: nine dependency-cruiser rules, CI, package-export-aware Vitest resolution, exact dependency pins, worker/process isolation, Effect-native compiled-binary certification, and the semantic `local/module-order` gate.

**Read in order:** `.dependency-cruiser.cjs` (all nine rules: `frontends-must-not-import-backend`, `renderer-must-not-import-client-ts`, `client-ts-barrel-only`, `electron-ipc-package-isolated`, `shared-ipc-stays-pure`, `preload-imports-allowlist`, `ink-input-package-isolated`, `client-ts-no-circular`, and `renderer-no-node-appcontext`) → `.github/workflows/ci.yml` → `scripts/binary-smoke.ts` + `scripts/binary-smoke-model.ts` + `scripts/binary-smoke.test.ts` → `scripts/fixtures/job-control.sh` → `package.json` → `knip.jsonc` → `tsconfig.json` + `vitest.config.ts` → `eslint.config.mjs` → `eslint-rules/index.mjs` → `eslint-rules/module-order.mjs` → `eslint-rules/module-order-analysis.mjs` → `test/eslint/module-order.test.mjs` → the deleted historical design path `docs/superpowers/specs/2026-07-10-eslint-module-order-design.md` (not present at HEAD) → `.gitignore` → `CODEOWNERS`.

Workspace packages resolve through their package exports in Vitest, while app/internal aliases remain explicit. Review that published subpath behavior is exercised rather than bypassed by source aliases.

**Scrutinize hardest:**
- **Glob completeness** in `.dependency-cruiser.cjs`: a new frontend or renamed path must not escape I-1, and `renderer-no-node-appcontext` must continue excluding ambient Node context from the renderer.
- **Binary certification ownership:** `scripts/binary-smoke.ts` is the Effect state machine for compiled CLI/server lifecycle. `scripts/fixtures/job-control.sh` is the narrow registered shell host boundary and may contain only the job-table primitives needed to signal and wait through a stable Bash job spec. Numeric PIDs are identity evidence, never signal authority; uncertain ownership preserves the data directory.
- **Data-dir isolation:** every compiled CLI/server invocation uses the same explicit directory while a sentinel home proves nothing touched the channel default. This is the end-to-end proof that explicit directories neither migrate nor contaminate default state.
- **Worker headroom:** the normal lane keeps `maxWorkers: "50%"`; the serial project owns the process-heavy lock and example suites. Direct script tests remain typechecked and collected.
- **Four stable module-order groups:** imports → exported classes/interfaces → other exports → private statements. Confirm import-equals, `export =`, namespace/default/abstract/declared forms, re-exports, and the empty module marker land correctly without reordering declarations inside a group.
- **Autofix proof:** runtime-bearing statements, module-source requests, and provider→consumer value dependencies constrain the preferred order. Unsafe ordering reports without changing text; safe output is idempotent.
- **Text ownership and parse safety:** leading/member/trailing comments, directives, shebangs, prologues, CRLF, ASI continuation tokens, and shared-line boundaries either travel with a proven owner or disable the fix.
- **Migration equivalence:** preserve public names, bodies, eager order, allocation count, schema/layer identity, and package boundaries; do not treat the earlier module-order migration as formatting.

**Best tests and commands:** `test/eslint/module-order.test.mjs`, `test/architecture/depcruise-exclude.test.ts`, `scripts/binary-smoke.test.ts`, `npm run lint`, and `npm run cert:cli:build`. If testing autofix, run `npm exec -- eslint . --fix` twice and require the second pass to leave no diff.

### Stage 8 — Migrated development surfaces  ·  60–90 min  ·  🔴 high

The migration also changed the code that proves, builds, packages, exercises, and measures the product. Review shared ownership mechanisms completely; sample only repetitive fixture-body syntax conversions after the shared seam is understood.

#### 1. Shared Effect-aware architecture/test helpers

**Representative files:** `test/support/effect-process.ts`, `test/support/effect-files.ts`, `test/support/process-spawner.ts`, and `test/support/effect-process.test.ts`.

**Scrutinize:** Read these completely. Process handles, stream drains, temporary directories, interruption, and combined cleanup Causes are shared by many suites; a leak or swallowed failure here makes downstream evidence unreliable. **Matching tests:** `test/support/effect-process.test.ts` and the architecture suite.

#### 2. Contracts/client/server test migration and process fixtures

**Representative files:** `packages/contracts/test/project-sync.test.ts`, `packages/client-ts/test/process-services.ts`, `packages/client-ts/test/fixtures/spawn-lock-contender.ts`, `apps/server/test/fixtures/state-root-lock-contender.ts`, `apps/server/test/fixtures/trust-boundary-host.ts`, and `apps/server/test/unit/harness.test.ts`.

**Scrutinize:** Read process fixtures and shared lifecycle harnesses completely: acquisition, interruption, child exit, socket/database closure, temporary-state removal, and full cleanup `Cause` preservation must survive assertion failure. Representative repetitive `it.effect`/`it.live` conversions may be sampled when they only replace fixture syntax without changing assertions. **Matching tests:** `packages/client-ts/test/integration/process-control.test.ts`, `packages/client-ts/test/integration/find-or-spawn.test.ts`, `apps/server/test/integration/state-root-lock.test.ts`, and `apps/server/test/unit/harness.test.ts`.

#### 3. Desktop/TUI UI adapters and Playwright host bridge

**Representative files:** `apps/desktop/test/ui/ui-harness.tsx`, `apps/tui/test/ui/runtime-harness.ts`, `apps/desktop/e2e/effect-test.ts`, `apps/desktop/e2e/helpers.ts`, and `apps/desktop/e2e/playwright.config.ts`.

**Scrutinize:** Read the host-required Promise adapter and shared UI harnesses completely. Playwright has one exact callback bridge; React/Ink roots, Electron/CDP processes, ports, listeners, runtimes, and temporary data must close on failure or interruption. Repetitive spec bodies may be sampled only after confirming all Page, Locator, Electron, and assertion Promises translate immediately through that bridge. **Matching tests:** `apps/desktop/test/unit/playwright/effect-test.test.ts`, `apps/desktop/test/unit/renderer-root.test.tsx`, `apps/tui/test/ui/use-projects.test.tsx`, and the desktop E2E suite.

#### 4. Build, fold-version, desktop, package, and manifest programs

**Representative files:** `scripts/build.ts`, `scripts/fold-version.ts`, `scripts/desktop-command.ts`, `packages/contracts/scripts/prepare-publish.ts`, `packages/client-ts/scripts/prepare-publish.ts`, `docs/architecture/scripts/build.ts`, and `test/architecture/manifest-orchestration.test.ts`.

**Scrutinize:** Read transactional filesystem programs completely. Confirm laziness at import, typed parse/child failures, temporary-write-plus-rename transactions, exact cwd/argv, signal propagation, cleanup on interruption, deterministic generated output, and one first-party Effect entry per manifest command. **Matching tests:** `scripts/build.test.ts`, `scripts/desktop-command.test.ts`, both package `prepare-publish` tests, `docs/architecture/scripts/build.test.ts`, and `test/architecture/manifest-orchestration.test.ts`.

#### 5. Public client examples and smoke harnesses

**Representative files:** `examples/client-ts/adapter.ts`, `examples/client-ts/client-layer.ts`, `examples/client-ts/node-app-context.ts`, `examples/client-ts/bootstrap-projects.ts`, `examples/client-ts/archive-stale.ts`, `examples/client-ts/audit-log.ts`, and `examples/client-ts/test/helpers.ts`.

**Scrutinize:** Public imports must remain limited to package exports; named operations stay Effect-valued and lazy; the shared smoke helper owns backend, socket, and temporary state. Sample repeated example formatting only after fully reviewing the helper and runner boundary. **Matching tests:** every file under `examples/client-ts/test/`.

#### 6. Benchmark scopes and six-row smoke reporting

**Representative files:** `bench/main.ts`, `bench/selfcheck.ts`, `bench/report.ts`, `bench/rss.ts`, `bench/seed.ts`, the five files under `bench/scenarios/`, and `bench/bench.test.ts`.

**Scrutinize:** SQLite, backend, RSS sampler, temporary seed, Clock, and optional GC access must be scoped or injected; measured intervals and pure aggregation must not shift. Review all resource scopes and the six-row smoke report, not just a representative scenario. **Matching gates:** `npm run bench:selfcheck` and `npm run bench:events -- --smoke`.

#### 7. Compiled binary certification model

**Representative files:** `scripts/binary-smoke-model.ts`, `scripts/binary-smoke.ts`, `scripts/binary-smoke.test.ts`, and `scripts/fixtures/job-control.sh`.

**Scrutinize:** Read all four completely. The pure model must cover every ownership transition; the Effect program owns build, processes, groups, endpoint/lock evidence, bounded TERM-to-KILL cleanup, and temporary state. The shell fixture is the sole narrow job-table boundary and must contain no policy or orchestration. **Matching gate:** `npm run cert:cli:build`.

**Sampling rule:** Repetitive fixture-only syntax conversions may be sampled. Shared lifecycle helpers, process fixtures, transactional filesystem programs, and every host-required Promise adapter require complete review.

---

### Stage 9 — Permanent enforcement and certification  ·  75–105 min  ·  🔴 high

**What:** The permanent proof that Effect-only cannot regress through an unreviewed source, host exception, package artifact, or runtime certification path.

**Read in order:**
1. `docs/architecture/EFFECT_ONLY.md`.
2. `eslint-rules/effect-boundary-analysis.mjs`, then `eslint-rules/effect-boundary.mjs` and `eslint-rules/effect-host-boundaries.mjs`.
3. `scripts/package-certification.ts`, `scripts/package-certification.test.ts`, `scripts/binary-smoke.ts`, and `scripts/binary-smoke.test.ts`.
4. Final repair commits `a0ed15b`, `78ebfce`, `fdda3aa`, and `e7d9fc6`.

**Scrutinize hardest:**
- **Semantic non-vacuity and source-consumer coverage:** analyzer fixtures prove real violations; every tracked first-party source and each exact host record has a consumer. The install prepare step patches TypeScript so configured language-service errors, warnings, suggestions, and `Effect.fn` opportunities fail typechecking. Duplicate Node-import and `process.env` diagnostics are delegated to the semantic rule and exact host registry, while human review evaluates diff-specific Effect adoption.
- **Exact host exceptions:** file, declaration, construct, occurrence, host, and consumer must agree. No directory, glob, whole-file exemption, or inline disable is acceptable.
- **Ownership and cleanup:** package and binary certification own processes, filesystems, tarballs, temporary directories, locks, and process groups; cleanup preserves full failure/defect/interruption Causes.
- **Final repairs:** `a0ed15b` closes final Effect review findings across host roots, server release, desktop ports, tests, scripts, and examples; `78ebfce` enforces exact desktop trust and cleanup Causes; `fdda3aa` adds symlink-safe directory identity and failed-spawner re-election under the original deadline; `e7d9fc6` guarantees abnormal HTTP/core release and complete architecture policy links.
- **Renderer trust and runtime release:** packaged renderer identity and IPC admission are exact; HTTP timeout/failure cannot abandon core release; directory aliases cannot bypass identity; a failed elected spawner relinquishes ownership for a contender.

**Focused command matrix:**

```bash
npm run lint
npm run typecheck:all
npm run typecheck:desktop
npm run arch
npm run knip
npx knip --directory docs/architecture
NODE_ENV=test npm test
npm run bench:selfcheck
npm run bench:events -- --smoke
npm run cert:cli:build
npm run cert:packages
xvfb-run -a npm run e2e:desktop
```

---

<a id="the-fast-path"></a>
## The fast path (6–8 hours)

If you cannot do the full pass, review these load-bearing correctness cores in order. This is an explicit reduced path, not certification and not permission to sample any item marked for complete review:

1. **Effect policy and architecture** — `docs/architecture/EFFECT_ONLY.md` and `docs/architecture/BOUNDARIES.md`; reconcile the functional core, host boundaries, and I-1 through I-4 map (35 min).
2. **Shared fold and context trace** — `packages/contracts/project.ts` plus `packages/contracts/app-context.ts`; trace AppContext/data-dir/default-vs-explicit lock derivation through `apps/cli/cli/main.ts`, `packages/client-ts/spawn-lock.ts`, `apps/server/runtime/state-root-lock.ts`, and `scripts/binary-smoke.ts` (60–75 min).
3. **Server HTTP/core and cleanup ownership** — `apps/server/transport/http-server.ts`, `apps/server/composition/app.ts`, `apps/server/application/projects/use-cases.ts`, and `apps/server/rpc/stream.ts`; focus on bounded transport release, guaranteed core closure, complete cleanup Causes, exact directory identity, mutex, and replay seam (60 min).
4. **Client session and ProjectSync epochs** — `packages/client-ts/client-session.ts`, `packages/client-ts/spawn.ts`, and `packages/contracts/project-sync.ts`; inspect stale-epoch exclusion, cleanup Causes, and failed-spawner re-election under one deadline (50 min).
5. **Electron packaged identity and port lifecycle** — `packages/electron-ipc/main.ts`, `apps/desktop/src/main/ipc/origin-rules.ts`, `apps/desktop/src/main/ipc/port-lifecycle.ts`, and `apps/desktop/src/renderer/app/runtime.ts`; verify exact renderer trust and main/preload/renderer scope ownership (55 min).
6. **Semantic analyzer and exact host registry** — `eslint-rules/effect-boundary-analysis.mjs`, `eslint-rules/effect-boundary.mjs`, and `eslint-rules/effect-host-boundaries.mjs`; require non-vacuity and exact consumers (45 min).
7. **Permanent architecture gates** — read `test/architecture/effect-policy.test.ts` and `test/architecture/effect-final-ratchet.test.ts`; confirm objective gates and manual diff-specific review compose rather than substitute for one another (40 min).
8. **Binary/package certification models** — `scripts/binary-smoke-model.ts`, `scripts/binary-smoke.ts`, `scripts/fixtures/job-control.sh`, and `scripts/package-certification.ts`; inspect process/filesystem ownership and fail-closed artifact checks (45 min).
9. **Retained foundation checks** — sample the matching behavioral tests, then preserve module-order review via `test/eslint/module-order.test.mjs` (35 min).

Reading the matching tests alongside each item gives the intended behavior fastest.

---

## At-a-glance summary

| Stage | Module | Layer | Complexity | Time |
|---|---|---|---|---|
| 0 | architecture docs | foundation | 🟡 | ~30 min |
| 1 | `packages/contracts` | foundation | 🟡 | 35–45 min |
| 2 | `apps/server` | backend | 🔴 | 75–90 min |
| 3 | `packages/client-ts` | shared client | 🔴 | 75–90 min |
| 4 | `apps/cli` | frontend | 🟢 | 30–45 min |
| 5a | `packages/ink-input` | shared client | 🟢 | 20–30 min |
| 5b | `apps/tui` | frontend | 🟡 | 40–55 min |
| 6a | `packages/electron-ipc` | boundary | 🔴 | 75–90 min |
| 6b | `apps/desktop` (main) | boundary | 🔴 | 45–60 min |
| 6c | `apps/desktop` (renderer) | frontend | 🔴 | 75–90 min |
| 7a | `test/architecture` | enforcement | 🟡 | 45–60 min |
| 7b | infra + module ordering | infra | 🟡 | 60–75 min |
| 8 | migrated development surfaces | evidence | 🔴 | 60–90 min |
| 9 | permanent ratchets + certification | enforcement | 🔴 | 75–105 min |

**Golden thread to hold throughout:** *one* backend owns each selected state root; *one* fold derives it; clients only mirror the sequenced event stream; I-1 confines backend construction statically; and `backend.lock` enforces runtime uniqueness. If a change in any module would let two writers share a state root, let a frontend bypass client-ts ownership, or let a snapshot disagree with a replay — that's the bug worth finding.
