# Reviewing `feat/architectural-foundation`

A guided reading path for reviewing this branch. It is large — **478 commits, 368 files, ~26,400 insertions and only 60 deletions** — so treat everything here as *newly built*, not as a small diff on top of `develop`.

This guide orders the review by the **dependency graph**: you read each layer only after the layers it is built on. By the time you reach a frontend, you already understand the vocabulary, the backend, and the connection logic it relies on, so nothing is reviewed in a vacuum.

> **How to use this**
> - Each stage has a *plain-language summary*, *why it comes here*, a *file-by-file reading order*, the *handful of things worth scrutinizing hardest*, and the *tests that best prove intent*.
> - The module-order migration touched 55 configured TypeScript files across the graph. When an earlier stage shows a move-only diff, verify that the declaration body and owned comments stayed intact; Stage 7b explains the rule and the few non-mechanical transformations.
> - Time estimates are for a careful human review. The full path is ~10–12 hours. If you can't spend that, jump to **[The fast path](#the-fast-path-4-5-hours)**.
> - The whole branch is built to satisfy four load-bearing invariants (**I-1 … I-4**). Stage 0 explains them; every later stage references them.

---

## The big picture (read this first)

Expand is an AI-assisted dev-workflow tool. This branch lays its **architectural skeleton**: a strictly layered monorepo (Bun + **Effect v4 beta** — framework code lives under `effect/unstable/*`) where exactly **one** process owns each selected state root and every UI is a thin client.

```
                      packages/contracts          ← shared vocabulary (schemas, RPC, events)
                            │  (everyone imports this, it imports no one)
        ┌───────────────────┼─────────────────────────────┐
        ▼                                                   ▼
   apps/server   ── one backend/root ─┐          packages/client-ts
   (SQLite event log, sequencing,     │          the "connection brain":
    event bus, lifecycle, RPC)        │          discover/spawn backend,
        ▲                             │          one RPC session, reactive
        │  WebSocket RPC              │          project store, reconnect
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

- **Event sourcing + one shared fold.** The backend stores immutable domain events; current project state is *derived* by folding them. The fold lives in **one place** (`Project.foldList` in contracts) and is reused verbatim by the server *and* every client — so a snapshot can never disagree with a replayed stream.
- **Server read-model cache (optimization).** The server no longer re-folds the whole log on every read. It keeps an **in-memory live read model** (a `SubscriptionRef`) seeded at boot from a **persisted `projection_state` row** (name-keyed: serialized state + `last_seq` + per-projection fold version) and advanced per commit — reads are O(rows), boot is O(tail-since-checkpoint). Checkpoints are written at boot, **debounced during the session (500ms quiet)**, and **once more at I-4 shutdown**, so a boot's tail is bounded by the debounce window after a crash and ~empty after a graceful cycle. The row is a disposable cache stamped with `FOLD_VERSIONS.projects` (rebuild-from-zero on mismatch) and proven equal to a full replay by `snapshot-equivalence.test.ts` — *snapshot can never disagree with replay* still holds as a **checked invariant**. See `docs/architecture/decisions/2026-07-05-event-store-foundation-design.md`.
- **Protocol v2.** Clients bootstrap by (1) subscribing to the `Events` stream *first*, (2) seeding from a `{projects, seq}` snapshot, (3) gating the live fold by `seq`. This avoids losing or double-applying events during the bootstrap window.
- **One explicit state root.** `AppContext` normalizes one data directory to an absolute path and derives the database, endpoint, log, and client spawn-lock paths from it. The CLI exposes it as a true global `--data-dir` flag; the desktop and standalone server retain raw-argv support; every spawned backend receives the same selected directory; and `backend.lock` prevents two live backends from sharing it.
- **Branded scalars.** `ProjectId` / `ProjectName` / `Tag` are nominal types validated at the schema boundary — the system's trust boundary for untrusted input.
- **Effects-as-data / dependency injection.** UI logic and Electron wiring are kept pure and testable; side effects and platform primitives are isolated to a single seam each.

---

## The review path

### Stage 0 — Architecture anchors  ·  ~20 min  ·  🟢 low

**What:** The written contract for the whole branch — the four invariants and the C4 model.

**Why here:** Everything downstream is justified by these rules. Read them so each later module maps to a named invariant.

**Read in order:**
DONE 1. `docs/architecture/BOUNDARIES.md` — I-1…I-4: the rule, *why* it matters, and *how* it's enforced. Note the "Modifying these invariants" clause: changing a rule requires changing the doc, the C4 model, and the enforcement test together.
DONE 2. `docs/architecture/expand.c4` — the system/container/component model. Skim the `overall` and `backend` views to see the intended shape.

**Scrutinize:** Whether the prose rules are specific enough to be enforceable (they are later turned into tests in Stage 7 — keep them in mind).

---

### Stage 1 — `packages/contracts`  ·  35–45 min  ·  🟡 medium

**What:** The shared vocabulary every other package imports and nothing imports back: branded scalars, the domain event union, the canonical `Project` read-model with its fold logic, the RPC surface, the discovery-file schema, the runtime data-path context, and the CLI output envelopes.

**Why here:** It is the foundation (`dependsOn: none`). Every later module speaks this language.

**Read in order:**
DONE (2026-07-05: fold versions became per-projection — re-read the FOLD_VERSIONS part; 2026-07-07: the fold is now ONLY Project.foldList — server/domain/project.ts removed) 1. `project.ts` — **start here.** Branded scalars + the opaque `Project` and its canonical statics `fromCreated` / `applyEvent` / `foldList`. *This fold is the single source of truth reused by server and clients alike.* Also drives **`FOLD_VERSIONS`** — a per-projection map (name → build-time SHA-256 of that projection's fold nodes; `projects` hashes the `Project` class), generated into `packages/contracts/fold-version.generated.ts` by `scripts/fold-version.ts` (`bun run gen:fold-version`). The server stamps `FOLD_VERSIONS.projects` on the persisted `projection_state` row; a mismatch forces a from-zero rebuild. It changes automatically when the fold changes — no manual bump (pinned by `test/architecture/fold-version-lockstep.test.ts`).
DONE 2. `events/meta.ts` — tiny `withMeta()` helper that gives every event a common envelope.
DONE 3. `events/project.ts` — the 7 event variants (Created/Renamed/DirectoryChanged/Archived/Restored/MetadataChanged/Deleted).
UPDATED 4. `events/domain-event.ts` → `events/domain.ts` — the internal module constructs the `DomainEvent` union and JSON codec once; the public module constructs `SequencedEvent {seq, event}` and re-exports those exact schema identities. The helper subpath is explicitly blocked from the source and staged package exports.
DONE 5. `rpc.ts` — the `ExpandRpcs` group + tagged errors. Focus on Protocol v2: `ProjectList → {projects, seq}` and the `stream:true` `Events`/`Connect` RPCs with `fromSeq`.
DONE 6. `endpoint.ts` — discovery-file schema + `PROTOCOL_VERSION = 2` (I-3).
NEW (2026-07-12) 7. `app-context.ts` — the single path derivation contract: `defaultDataDir()` chooses the channel home, `makeAppContext(dataDir?)` derives every runtime path from an explicit override, and the default reference still recognizes raw `--data-dir` argv for standalone server/Electron entrypoints.
MOVED 8. `cli.ts` — the stable `expand/v1` JSON envelopes the CLI prints.

**Scrutinize hardest:**
- **Single fold, no second copy.** Confirm `foldList`/`applyEvent` here are genuinely the *only* projection and that server + client-ts reuse them (any divergence breaks snapshot-vs-replay consistency).
- **`applyEvent` semantics:** `MetadataChanged` is a partial patch keyed on `!== undefined` (omission keeps a field; `null` clears it). Tags dedupe via `new Set`. Check `undefined` vs `null` intent.
- **`foldList` replay-safety:** create is idempotent, delete tombstones, unknown ids are no-ops — must match how the server sequences and the client gates by `seq`.
- **Validation bounds are the system trust boundary:** name/tag regex, UUIDv4 ids, description ≤ 2048, directory ≤ 4096 — the *same* limits must apply on both the event and RPC schemas.
- **`PROTOCOL_VERSION` coupling:** any shape change must bump the version (clients reject mismatches).
- **Published schema identity:** `events/domain.ts` must retain the emitted `./domain-event.js` specifier, strict identity with the internal schemas, and `ERR_PACKAGE_PATH_NOT_EXPORTED` for direct helper imports.
- **Path coherence:** an explicit data directory must change `dataDir`, `dbPath`, `endpointFile`, and `logDir` together; omitting it must preserve the channel-specific default.

**Best tests to read:** `test/project-fold.test.ts` (the projection), `test/events.test.ts` (round-trips + legacy decode), `test/rpc.test.ts` (validation at the RPC boundary), and `packages/contracts/test/app-context.test.ts` (default-vs-explicit path derivation).

---

### Stage 2 — `apps/server`  ·  75–90 min  ·  🔴 high

**What:** The authoritative backend for one selected state root (I-2). An event-sourced service: mutations append immutable events to a SQLite log (monotonic `seq`); the read-model is an **in-memory live projection seeded at boot from a persisted snapshot** (folded from the log only for the tail since that snapshot, or from zero on first boot / `FOLD_VERSIONS.projects` mismatch), and it's all served over a token-guarded, loopback-only WebSocket RPC. It safely relocates the legacy default home before boot, owns the root through `backend.lock`, writes that root's endpoint file on boot (I-3), and self-shuts-down at zero connections for the root (I-4).

**Why here:** It depends only on `contracts`, and it's the source of truth every client mirrors. Understand it before any client.

**Read in order:**
DONE 1. `packages/contracts/events/project.ts` — refresh the event vocabulary the backend stores.
DONE 2. `db/event-store.ts` — the BASE: the append-only `events` table DDL plus the raw primitives (`append`, and the keyset-paginated streaming `scan` whose undecodable rows are **defects** carrying `{seq, stream_id, event_type}`). The primitives are NOT a service: `specializeEventStore(build)` is the only door — it hands them to a specialization builder as a closure, so raw `scan`/`append` cannot be summoned from context anywhere (see the specialization ADR, 2026-07-05). Chunk granularity comes from the `EventScanChunkSize` reference (default 1000). Then the two specializations: `db/replay-feed.ts` — `ReplayFeed.read(fromSeq)`, the unfiltered seq-ordered feed the RPC backlog replays — and `application/projects/project-event-store.ts` — `ProjectEventStore.read(fromSeq)` (tag filter derived from the `ProjectEvent` union) and `append(event)`, which derives `stream_id` from `event.projectId` so a mismatched stream id is unrepresentable.
DONE 3. `db/projection-state-store.ts` + `application/projections.ts` — the read-model cache. `projection-state-store.ts` is the name-keyed `projection_state {name, state, last_seq, fold_version}` table (`load` returns `null` on absent/NULL-state; `save` upserts state+cursor in ONE row — the persisted mirror of the C2 pair). `projections.ts` boot-catches-up via streamed folds (`ProjectEventStore.read`), then keeps checkpointing: a scoped debounce fiber (500ms quiet) plus a shutdown finalizer registered BEFORE the fiber so teardown interrupts-then-writes. `list`/`snapshot` read the `SubscriptionRef`; `apply` advances it with the C2 seq-gate.
DONE 4. `application/event-bus.ts` — in-memory `PubSub` of `SequencedEvent` (the live half of the stream).
DONE 5. `application/projects/use-cases.ts` — **the busiest, riskiest file.** Every mutation, the `Semaphore(1)` mutex, directory validation, and the uninterruptible `commit` (**append via `ProjectEventStore` → `projection.apply` (advance the in-memory model) → publish** — `commit(event)` takes only the event; the stream id derives inside the facade).
DONE 6. `connection-tracker.ts` — the `Ref(count)` + armed-flag + `Deferred` state machine for I-4.
DONE 7. `rpc-handlers.ts` — binds the contract to use-cases; the `catchIf`/`Effect.die` "only declared errors cross the wire" pattern. The `fromSeq` replay logic itself lives in `apps/server/rpc/stream.ts` (composed here via `...streamHandlers`).
DONE 8. `http.ts` — WebSocket transport: `timingSafeEqual` token check, loopback bind, access log that strips the token.
NEW (2026-07-12) 10. `state-root-lock.ts` + `startup-ownership.ts` — the shared hardened lock machinery and startup seam. Development and release default roots serialize migration through `<home>/.expand-locks/legacy-migration.lock`; the guard is released only after the startup-aware scoped `backend.lock` lease exists, and a stuck live guard fails after the bounded four-second handoff. Raw root acquisition rejects a live owner immediately; startup gives an endpoint-absent owner the same bounded shutdown handoff. Dead-owner reclaim and release require unchanged PID/token/inode evidence, and invalid or changing evidence fails closed.
UPDATED (2026-07-12) 11. `composition/app.ts` → `main.ts` — lifecycle orchestration and the thin entrypoint. `main.ts` now obtains `startupOwnership` before the file logger, database, or `AppLayer` is built. Default startup acquires the external migration guard, migrates, acquires the lifetime root lease, then releases the guard; non-default roots bypass migration and retain the root-lock flow. This ordering lets a replacement wait for an endpoint-absent predecessor without overlapping ownership and prevents coordination artifacts from pre-creating the nested target. It sets `process.umask(0o077)` before anything touches the filesystem, while `app.ts` fail-closed-`chmod`s the data dir (`0700`), SQLite log (`0600`), and WAL/SHM sidecars if present (`secureIfPresent`).

**Scrutinize hardest:**
- **Concurrency:** the single `Semaphore(1)` is the *only* thing serializing read-validate-commit. Confirm every mutating use-case goes through it and uniqueness/"exactly-one-winner" guards can't be bypassed.
- **`fromSeq` replay seam** (`apps/server/rpc/stream.ts`, composed into `rpc-handlers.ts`): subscribe → read backlog → filter live by `seq > lastReplayed`. Verify **no gap or duplicate** between backlog tail and first live event under concurrent appends. The backlog is now STREAMED (`ReplayFeed.read`), so `lastReplayed` is a `Ref` initialized to `fromSeq` and advanced as the backlog flows; the live filter reads it only after `Stream.concat` switches over.
- **`commit()`:** append (SQLite) + publish (PubSub) are two systems wrapped in `uninterruptible`. A failure between them desyncs bus from log — confirm "log is source of truth, bus is best-effort" is intended.
- **Fail-fast decode:** `scan` dies on any undecodable row (defect names seq/stream_id/event_type). This deliberately REVERSES the earlier skip-with-warning trade-off (ADR 2026-07-05): silently-vanishing projects were judged worse than a refusing boot. Verify the defect carries enough context to act on, and that no caller re-introduces a silent skip.
- **The read-model cache:** confirm the four guards that keep the persisted state equal to a replay — (1) checkpoints are written only by the projection's own scope (boot save, the debounce fiber reading consistent C2 pairs, and the shutdown finalizer — commit path writes NOTHING to projection_state), (2) each row is stamped at the state's own `seq`, (3) tail catch-up and from-zero rebuild both go through the same shared fold, and (4) a `FOLD_VERSIONS.projects` mismatch forces a from-zero rebuild. Also verify the finalizer-before-fiber registration order (teardown must interrupt the fiber BEFORE the final write).
- **Migration safety:** the default-home gate, root `events.db` marker, deterministic staging path, shared cross-channel guard, and ambiguous-layout refusal are the data-loss barriers. For a direct-child target, verify every crash state either completes on retry or fails with the recoverable legacy/staging path before the target root lock can create a fork. The guard must remain held through root-lease acquisition; every selected path other than `defaultDataDir()` bypasses migration.
- **State-root ownership** (`state-root-lock.ts` + `startup-ownership.ts` + `main.ts`): I-1 confines construction statically, but `backend.lock` is the runtime singleton. Confirm an advertised live owner rejects promptly, an endpoint-absent live owner gets only a bounded startup/shutdown handoff with no overlapping lease, a stale endpoint without a live owner remains replaceable, distinct roots coexist, stale reclaim and release verify unchanged PID/token/inode evidence, malformed evidence fails closed without retry, and a stale finalizer cannot delete a replacement lease.
- **On-disk secrecy** (`main.ts` + `composition/app.ts`): the endpoint file carries the loopback auth token and the SQLite log carries every event, so both must stay group/world-unreadable. `umask(0o077)` narrows the default creation mode and the fail-closed `chmod`s tighten anything already on disk. Confirm the `umask` is set *before* any file is created (it runs before the runtime boots), and that `secureIfPresent` genuinely narrows the WAL/SHM sidecars once they exist rather than silently skipping them.

**Best tests to read:** `test/integration/state-root-lock.test.ts`, `test/integration/concurrency.test.ts`, `test/integration/events-replay.test.ts`, `test/integration/durability-restart.test.ts` (snapshot advances across a restart; the checkpoint-write cadence itself is pinned by the checkpoint-cadence tests in `projection.test.ts`), `test/integration/trust-boundary.test.ts`, `test/integration/snapshot-equivalence.test.ts` (the proof that state@k+tail == fold-from-zero), `test/integration/projection-state-store.test.ts`, `test/integration/project-event-store.test.ts`, `test/integration/replay-feed.test.ts`, the boot-matrix + checkpoint-cadence tests in `test/integration/projection.test.ts`, `test/integration/events-handler.test.ts` (the streamed-backlog dedup gate), and the new `migrate-default-home.test.ts` + expanded `migrate-legacy-home.test.ts` recovery matrix.

---

### Stage 3 — `packages/client-ts`  ·  75–90 min  ·  🔴 high

**What:** The "connection brain" shared by all three frontends: a platform seam (Bun/Node), per-root find-or-spawn discovery, the RPC session + presence handshake, and the reactive `ProjectStore` that mirrors backend state and survives reconnects. Hosts no `AppLayer` (I-2); reaches the selected root's backend only via its discovery file (I-3) and never imports `apps/server` (I-1). Its public API is a **curated, Effect-native SDK surface**: external code enters *only* through the scoped entrypoints — `@expand/client-ts` (connection core), `@expand/client-ts/project`, `@expand/client-ts/server`, and `@expand/client-ts/adapters/{bun,node}` — every other module is internal (tagged `@internal`) and made unreachable from outside by the `client-ts-barrel-only` dependency-cruiser rule (see Stage 7).

**Why here:** Depends on `contracts` + `server`; consumed by every frontend. The CLI/TUI/desktop chapters are short because this is where their real logic lives.

**Read in order:** *(public entrypoints = `index.ts`/`project/index.ts`/`server/index.ts` + `adapters/{bun,node}`; everything else is package-internal)*
DONE 1. `ARCHITECTURE.md` — **read first**, the author's own line-referenced walkthrough. Its "Public API surface" section is the map of what each entrypoint (root, `/project`, `/server`, `adapters/*`) exports and what is `@internal`.
DONE 2. `index.ts` + `project/index.ts` + `server/index.ts` — the public entrypoints: root = strict connection core; the domain surfaces live on the `/project` and `/server` subpaths (one canonical import path per symbol).
UPDATED (2026-07-12) 3. `adapter.ts` — the 2-member `RuntimeAdapter` platform seam; `spawnBackend(dataDir)` receives the selected state root while endpoint discovery separately confirms readiness.
UPDATED (2026-07-12) 4. `discovery.ts` + `spawn.ts` + `spawn-lock.ts` — `discovery.ts` validates the selected root's endpoint and owning PID; `spawn.ts` owns find-or-spawn and the **10-second** endpoint-advertisement deadline; `spawn-lock.ts` owns atomic lease publication plus token/inode-safe dead-owner recovery and release. Default roots coordinate outside the nested migration target, while non-default roots remain root-local.
5. `rpc-client.ts` — `acquireClient`: builds the protocol layer, the presence handshake, stale-endpoint self-healing retry.
6. `adapters/bun.ts` + `adapters/node.ts` — the two platform implementations (socket + spawn); the platform subpath entrypoints (public alongside `/project` and `/server`).
7. `project/store.ts` — **the core engine:** the session loop, the **C2 atomic fold**, the public mirror, the reconnect loop, and the mutation methods.
8. `supervise.ts` — logs a background fiber's death unless it was a clean interrupt.
9. `project/client.ts` + `client-layer.ts` — the stateless facades and how layers share one connection.

**Scrutinize hardest:**
- **The C2 atomic fold** (`project/store.ts`): `{projects, seq}` live in one `SubscriptionRef` mutated together (gate `seq <= s.seq` → `foldList` → bump seq → publish), so a reader can never see a `seq` ahead of its `projects`. This is the central correctness claim.
- **Bootstrap window ordering:** Events subscribed *before* `ProjectList`, `Math.max` on seq, one-time seed before signalling ready. An off-by-one silently loses or double-applies events.
- **Spawn convergence** (`spawn.ts` + `spawn-lock.ts`): a valid live owner remains contended regardless of age; dead current or tokenless legacy owners are reclaimed only through exact record/inode evidence; malformed or changing evidence remains untouched; and release removes only its own lease. Concurrent callers on one root must spawn once, callers on distinct roots must proceed independently, and the external default-root lock must not pre-create the nested migration target. The server's `backend.lock` still enforces lifetime uniqueness.
- **Startup timing:** the client must still be pending at nine seconds, accept a valid endpoint advertised after six seconds, and fail deterministically at ten seconds. The TestClock tests synchronize on a post-spawn filesystem poll before advancing virtual time so they cannot pass or fail through scheduler luck.
- **Data-directory propagation:** discovery, the derived spawn-lock path, endpoint polling, and the adapter's backend argv must all come from the same normalized `AppContext`; mixing the default endpoint with an explicitly selected database would create two independent backends.
- **Reconnect classification** (`project/store.ts`): `Cause.hasInterruptsOnly` must separate deliberate shutdown (propagate) from a dropped socket (retry with backoff). Misclassifying either hangs or busy-loops.
- **Non-optimistic state:** mutations only call the RPC; state changes only when the server's event flows back. Confirm there's no optimistic local write.
- **Entrypoint boundary** (`index.ts`/`project/index.ts`/`server/index.ts` + the `client-ts-barrel-only` rule): external code must reach the package only via the entrypoints; internals are `@internal` and depcruise-forbidden from outside. Confirm the rule is non-vacuous (it flags a real deep import) and note its one blind spot — depcruise excludes `test/`, so the rule does not police test files (all current out-of-package tests go through the public entrypoints; client-ts's own tests deliberately deep-import internals relatively).

**Best tests to read:** `test/integration/snapshot-consistency.test.ts` (the C2 proof; the stress loop now compares cached state signatures inline instead of retaining up to 200,000 snapshots), `test/integration/find-or-spawn.test.ts` (same-root convergence, distinct-root independence, stale locks, and the six-/ten-second deadline), `test/integration/bootstrap-window.test.ts`, `test/integration/reconnect.test.ts`, `test/integration/cross-store-sync.test.ts`, `test/architecture/client-ts-barrel.test.ts` (the public-API boundary), `packages/client-ts/test/unit/entrypoints.test.ts` (pins the `/project` + `/server` surfaces and the strict-core root — domain symbols must NOT be reachable from `@expand/client-ts`).

**Dogfood the public surface — `examples/client-ts/`:** three runnable real-world programs written as an *external consumer* would — `bootstrap-projects.ts` (create a project per subfolder, deduping/skipping conflicts), `archive-stale.ts` (archive projects whose directory has vanished), and `audit-log.ts` (tail `ProjectStore.events` to a JSONL file). Every import comes only from the public entrypoints (`@expand/client-ts`, `@expand/client-ts/project`, `@expand/client-ts/adapters/bun`) — the `client-ts-barrel-only` rule (Stage 7) now covers this directory, so a deep import into a package internal fails CI, and each example has a subprocess smoke test in `examples/client-ts/test/` that runs it against an isolated backend. **Read `examples/client-ts/ERGONOMICS.md` alongside this stage** — it is a file-referenced list of what felt awkward to build against the SDK (which command surface to reach for and why, boilerplate the SDK doesn't yet absorb, and where the "public API only" promise leaks). It is the concrete output of this dogfooding pass and the best single signal of whether the `client-ts` shape is right.

---

### Stage 4 — `apps/cli`  ·  30–45 min  ·  🟢 low

**What:** A thin, agent-friendly CLI that turns shell verbs into typed RPC calls and prints stable, versioned JSON envelopes (`apiVersion "expand/v1"`) with distinct per-error exit codes. It also owns the parsed global `--data-dir` surface used to isolate the CLI and the backend it spawns. Holds no business logic.

**Why here:** It's the **simplest complete frontend** — review it first among the UIs to see the full `frontend → client-ts → RPC → backend` loop without any UI complexity.

**Read in order:**
UPDATED (2026-07-12) 1. `cli/app-context-layer.ts` + `cli/main.ts` — the parsed `DataDir` setting becomes an `AppContext` layer before the composition root provides the real Bun client; `main.ts` then builds the command tree and installs the JSON error formatter (`makeExpand` factory + `import.meta.main` guard).
2. `cli/_command.ts` — the `defineCommand` seam every verb flows through (envelope/text/quiet rendering).
UPDATED (2026-07-12) 3. `cli/output.ts` + `cli/global-flags.ts` — stdout/stderr discipline and the `--format`/`--quiet` flags plus `DataDir`, a true global directory flag accepted before or after any subcommand and allowed to name a not-yet-created directory.
4. `packages/contracts/cli.ts` + `cli/contract/envelope-internal.ts` + `cli/contract/envelope.ts` — the envelope schemas being hand-built; the internal owner constructs `ENVELOPE_VERSION` and `ErrorCode` once before the opaque envelope classes, and the public module re-exports those exact bindings.
5. `cli/commands/project/create.ts` — a representative command (the pattern all verbs follow).
6. `cli/commands/project/_resolve.ts` — name-or-UUID target resolution.
UPDATED (2026-07-12) 7. `cli/errors/index.ts` + `cli/errors/project-errors.ts` + `cli/errors/parser-errors.ts` + `cli/run.ts` — the contract/parser-error → CLI-error mapping (stable codes/exit codes) and the top-level error boundary. Parser failures such as an existing file passed to `--data-dir` must still produce one structured `INVALID_ARGUMENT` envelope and exit 2.

**Scrutinize hardest:**
- **Error-mapping fidelity:** unmapped `_tag`s silently fall through to `UNEXPECTED` (exit 1) — verify the switch tables cover the real contract error set.
- **Exit codes are an external API** for scripting agents — confirm codes (1/2/5/6/7/8/9/10) and `retryable` flags are stable and tested.
- **stdout/stderr purity:** a failure must emit nothing on stdout and exactly one JSON line on stderr.
- **Envelopes are hand-built** (not `Schema.encode`d), so drift vs `contracts/cli.ts` is possible — the snapshot/contract tests are the safety net.
- **Global data-dir semantics:** help must expose the flag at root and child levels; before/after-subcommand positions must resolve identically; existing and absent directories must work; an existing file must fail before a handler runs; omission must retain the channel default.

**Best tests to read:** `test/contract/contract.test.ts` (the behavioral matrix, including the global data-dir contract), `test/unit/global-flags.test.ts`, `test/unit/errors.test.ts`, `test/unit/envelope-schema.test.ts` (freezes the output contract).

---

### Stage 5 — Terminal UI: `packages/ink-input` → `apps/tui`  ·  60–85 min

Read the input framework first, then the TUI that consumes it.

#### 5a — `packages/ink-input`  ·  20–30 min  ·  🟢 low

**What:** A small, ink-agnostic input framework. It exists to defeat a structural flaw in Ink: its `useInput` is a global broadcast with no consumption or priority, so exclusive routing requires that *exactly one* handler exist. The package provides that single router plus pure helpers (key normalization, first-match binding resolution, text-field semantics) and contains **zero app policy**.

**Read in order:** `HOW-IT-WORKS.md` (first) → `key-name.ts` (canonical key names) → `bindings.ts` (`resolveBinding`, first-match-wins) → `text-field.ts` (the paste-vs-keypress rule + code-point-safe editing) → `use-key-router-ink.tsx` (the one `useInput`) → `components/hint-bar-ink.tsx`.

**Scrutinize hardest:** the **single-router invariant** (one `useInput` repo-wide, pinned by an arch test); the `textFieldConsumes` rule `input.length>0 && keyName===input` (so a pasted literal `"return"` is text but a real Enter falls through); and that the *same* binding table drives both routing and the hint bar, so help can never drift from behavior.

**Best tests:** `test/text-field.test.ts`, `test/key-name.test.ts`, and `test/architecture/tui-input-boundary.test.ts`.

#### 5b — `apps/tui`  ·  40–55 min  ·  🟡 medium

**What:** The Ink terminal frontend — a one-screen project manager driven by a **pure unidirectional pipeline**: `useKeyRouter → route() (pure) → uiReduce() (pure) → runEffect (the single impure seam) → ProjectStore`.

**Why here:** Depends on `contracts` + `client-ts` + `ink-input`.

**Read in order:** `runtime.ts` (client-only `ManagedRuntime`) → `main.tsx` → `input/state.ts` (the vocabulary) → `input/bindings.ts` → `input/route.ts` (modal top-down, text first-refusal) → `input/reduce.ts` (state transitions + `DomainEffect` data + `reconcile()`) → `use-projects.ts` (the Effect↔React bridge) → `components/app.tsx` (the only stateful component, holds `runEffect`) → `components/project-list.tsx`.

**Scrutinize hardest:**
- **C1 fix:** `route()` can *never* turn a typed command-letter (`a`, `d`, …) into a command while typing. The create/overlay branches must reach no command lookup.
- **`reconcile()` selection math** under concurrent mutations (clamping, vanished selection, empty list, overlay auto-close) — off-by-one here is a silent data/UX hazard.
- **`submitOverlay`:** empty rename/dir is a keep-open no-op, but empty metadata description *deliberately clears* to null (C8) — confirm intent vs. accidental data loss.

**Best tests to read:** `test/unit/route.test.ts` (C1 at the routing layer), `test/unit/reduce.test.ts` (effects + reconcile races), `test/ui/app-input-routing.test.tsx` (end-to-end C1).

---

### Stage 6 — Desktop: `packages/electron-ipc` → `desktop-main` → `desktop-renderer`  ·  ~3–4 hrs

The largest area (85 files). Read the IPC framework, then the privileged main process, then the renderer. This is where I-1 is most aggressively defended.

#### 6a — `packages/electron-ipc`  ·  75–90 min  ·  🔴 high

**What:** A typed, contract-driven IPC framework. The main process is the trust boundary; raw Electron IPC primitives are confined to **two adapter files**. In production the renderer never imports `apps/server` and reaches the backend only through a transferred `MessagePort` handed over by this framework.

**Read in order:** `contract.ts` (the pure DSL — channel kinds, wire names, result envelopes, type derivations) → `main.ts` (the 5-step security pipeline + `bindIpc`) → `renderer.ts` (the Effect client) → `preload.ts` (the small auditable bridge) → `main-electron.ts` + `preload-electron.ts` (the only files importing `electron`) → `apps/desktop/src/shared/ipc/channels.ts` (the real contract — a *single* `portExchange` channel).

**Scrutinize hardest:**
- **Sender validation** (`main.ts`): the main-frame check relies on **object identity** (`frame === target.mainFrame`); confirm `toFrameLike` preserves reference equality and that `exactOrigin` can never match the literal `'null'` opaque origin.
- **Defect sanitization:** handler/encode failures must collapse to `{_tag:'IpcDefect', message:'internal error'}` — no internal error text leaks across the bridge.
- **`portExchange` trust:** the port crosses via `window.postMessage`; on `file://` the origin falls back to `'*'`, so the load-bearing guards become `source === win` + channel + nonce in the renderer. Check all three, on every path (success/throw/timeout).
- **`payloadSize` fail-closed:** `JSON.stringify` returning `undefined` or throwing must both count as oversized.

**Best tests:** `test/validate-sender.test.ts`, `test/bind-ipc.test.ts` (full pipeline + defect hiding), `test/renderer.test.ts`.

#### 6b — `apps/desktop` (main process)  ·  45–60 min  ·  🔴 high

**What:** The privileged half of the desktop app — Electron **main** + preload + the shared IPC registry. On window creation it builds a `ManagedRuntime` hosting client-ts's `ProjectStore` (so **main is a client, not a server** — I-2), mints a fresh `MessageChannelMain` per `rpcPort` request, and runs a full Effect `RpcServer` (the same `ExpandRpcs` contract) on the main side of the port. Applies the renderer-hardening security pipeline.

**Read in order:** `src/shared/ipc/channels.ts` → `src/preload/index.ts` → `src/main/runtime.ts` (proves main is a client and inherits raw `--data-dir` through `AppContext`) → `src/main/index.ts` (the wiring hub: CSP, hardened `webPreferences`, navigation denial, `rpcPort` handler) → `src/main/rpc/server.ts` (`makePortProtocol` adapts `MessagePortMain` into an `RpcServer.Protocol`) → `src/main/rpc/transport.ts` → `src/main/rpc/handlers.ts` → `src/main/rpc/project-handlers.ts` (the proxy logic) → `src/main/rpc/connection-handlers.ts` (Connect status mirror + Events `fromSeq` gating) → `src/main/security/window-options.ts` + `ipc/origin-rules.ts` + `ipc/port-lifecycle.ts`.

**Scrutinize hardest:**
- **Security pipeline completeness:** CSP only in prod, the `sandbox`/`contextIsolation`/`nodeIntegration` pin, navigation/window-open denial, and — load-bearing — that the dev `exactOrigin` carve-out can **never** reach a production build (prod is `file://`-only).
- **Runtime selection:** Electron's raw `--data-dir` must reach the main-process `AppContext` and then the Node adapter's spawned backend argv.
- **Port lifecycle:** supersession (tear down the old port before minting a new one) and reload/close must interrupt stale port fibers, or you get hung requests / request-id collisions.
- **Error translation:** every store call rethrows `RpcClientError` as a *defect* (`Effect.die`), Health dies on disconnect — confirm no unsanitized backend message reaches the renderer.

**Best tests:** `test/integration/rpc-server.test.ts` (full round-trip), `test/integration/connection-honesty.test.ts`, `test/unit/origin-rules.test.ts`, `test/unit/port-lifecycle.test.ts`.

#### 6c — `apps/desktop` (renderer)  ·  75–90 min  ·  🔴 high

**What:** The React + TanStack Router UI. All backend access flows over the single `MessagePort` (I-1): a port-backed `RpcClient`, thin per-domain layers, and `RendererProjectStore` implementing the same Protocol v2 bootstrap. Effect is bridged to React by `makeAppHandle` (a `useSyncExternalStore`-compatible sync mirror) — React never touches Effect directly.

**Read in order:** `rpc/renderer-port.ts` → `rpc/transport.ts` (the port-backed protocol — the heart of the seam) → `rpc/project-rpc.ts` → `features/projects/data/project-store.ts` (Protocol v2 store) → `app/app-handle.ts` (the Effect→React bridge) → `app/runtime.ts` (boot: nonce-correlated port acquisition + 10s timeout) → `main.tsx` → `features/projects/data/use-projects.ts` → `features/command/components/CommandPalette.tsx` → `features/projects/pages/ProjectsView.tsx`.

**Scrutinize hardest:**
- **Bootstrap window** in `project-store.ts` (fork events pump → list snapshot → set `lastSeq` → fork fold loop): must neither drop the first post-snapshot event nor double-apply a stale one; check resubscribe/reconnect behavior.
- **MessagePort seam integrity (I-1):** renderer code reaches the backend *only* via the port; `window.expand` is the only bridge.
- **Inbound decode trust** (`transport.ts`): `parser.decode(event.data)` is cast to the message type with no validation — a hostile message on the port is assumed well-typed. Assess.
- **Effect/React lifecycle:** detached mirror fiber + `Effect.scoped` boot under `Effect.never` — verify scopes/fibers aren't orphaned.

> ⚠️ **Test-tree gotcha:** several files under `apps/desktop/test` (`connection-honesty`, `transport`, `rpc-server`, `window-options`, `harden-web-contents`, `origin-rules`, `port-lifecycle`, `backend-entry`) actually exercise the **main** process (Stage 6b), not the renderer — don't attribute their coverage to renderer code.

**Best tests:** `test/unit/renderer-project-store.test.ts` (the seq-gate), `test/unit/app-handle.test.ts`, `test/unit/renderer-boot-port.test.ts` (the I-1 handshake), `e2e/set-metadata.spec.ts` (full Playwright round-trip).

---

### Stage 7 — Enforcement, infra & project agents  ·  105–150 min

The capstone: how the invariants you've been tracking are *mechanically* guaranteed. Reviewing this last lets you judge whether the tests actually pin what the earlier stages claimed.

#### 7a — `test/architecture`  ·  30–45 min  ·  🟢 low

**What:** Eleven "fitness tests" that turn the prose invariants into build failures. They run `dependency-cruiser` programmatically *and* do their own filesystem/source-text assertions, with DO-NOT-MODIFY headers + CODEOWNERS routing so the rules can't be quietly relaxed. The backend-ownership test also pins the per-state-root I-2/I-3 wording and the `state-root-lock.ts` construction site.

**Read in order:** `docs/architecture/BOUNDARIES.md` (re-anchor) → `.dependency-cruiser.cjs` → `i1-cli-isolation.test.ts` (the flagship I-1 test) → `depcruise-exclude.test.ts` (the guard on the guard) → `client-ts-barrel.test.ts` (pins the `client-ts` public API — only the four entrypoint kinds `index.ts`/`project/index.ts`/`server/index.ts`/`adapters/*` are importable from outside; asserts the `client-ts-barrel-only` rule's exact `from`/`to` shape and a clean cruise) → `ipc-boundary.test.ts` → `tui-input-boundary.test.ts` → `server-app-split.test.ts` → `backend-ownership.test.ts` → `fold-version-lockstep.test.ts` (recomputes the per-projection fold-node hashes via `scripts/fold-version.ts` and asserts the committed `FOLD_VERSIONS` is current — the build fails until you `bun run gen:fold-version` and commit) → `test-colocation.test.ts` (allows colocated `scripts/*.test.ts(x)` and skips only the repository-root `.worktrees`) → `no-dead-code.test.ts` (runs **Knip** over both workspaces and fails on any unused file / export / exported type / dependency — the standing "no dead code" gate; config and every suppression are justified in `knip.jsonc`).

**Scrutinize hardest:**
- **Non-vacuity:** do the depcruise-backed tests actually *fail* when a real forbidden import is introduced (not just assert a name is absent + exit 0)?
- **Greps are coarse/bypassable:** substring matches (`/\buseInput\b/`, `/from "electron"/`) can be evaded by aliasing or dynamic `import()` — confirm a depcruise rule backstops each grep.
- **Hardcoded path lists go stale silently:** `SERVER_FILES`, the allowed-adapters set, the pure-module lists — a renamed file weakens the check without failing it.
- **Worktree scope:** only `<repo>/.worktrees` is excluded from the recursive colocation scan. A nested directory with that name must remain visible, otherwise arbitrary source subtrees could evade the architecture gate.

**Best tests:** `i1-cli-isolation.test.ts`, `depcruise-exclude.test.ts`, `test-colocation.test.ts`.

#### 7b — Infra & module ordering  ·  45–60 min  ·  🟡 medium

**What:** The build/CI/enforcement plumbing that makes all of the above checkable: the dependency-cruiser rules, the GitHub Actions pipeline, the TS/Vitest path aliases, the exact dependency pins, worker/process isolation, the compiled-binary smoke test, and the semantic `local/module-order` gate that replaces the deleted `local/exports-on-top` rule.

**Read in order:** `.dependency-cruiser.cjs` (the eight forbidden import rules — the I-1 engine in code, now including `client-ts-barrel-only`, the `client-ts` public-API boundary) → `.github/workflows/ci.yml` (checks → parallel desktop-e2e + binary-smoke) → `scripts/binary-smoke.sh` + `scripts/binary-smoke.test.ts` (compiled CLI/server certification with an explicit data directory and a tested ownership ledger) → `package.json` (scripts + exact Effect v4 beta pins) → `knip.jsonc` (the dead-code gate's config: the two workspaces, the narrow type/interface used-in-file allowance, and the documented `ws`/`@types/ws` cross-workspace false-positive suppression) → `tsconfig.json` + `vitest.config.ts` (the **duplicated** `@expand/*` alias maps, direct script-test inclusion, focused ESLint RuleTester collection, and the normal `maxWorkers: "50%"` lane followed by a serial process-heavy project) → `eslint.config.mjs` → `eslint-rules/index.mjs` → `eslint-rules/module-order.mjs` (diagnostic/fixer boundary) → `eslint-rules/module-order-analysis.mjs` (classification, constrained stable sort, and text-safety proof) → `test/eslint/module-order.test.mjs` → `docs/superpowers/specs/2026-07-10-eslint-module-order-design.md` → `.gitignore` (repository-root linked worktrees) → `CODEOWNERS`.

**Scrutinize hardest:**
- **Glob completeness** in `.dependency-cruiser.cjs`: a new frontend or renamed path would silently escape I-1.
- **Alias drift:** `tsconfig.json` paths, `vitest.config.ts` `resolve.alias`, and `apps/desktop/tsconfig.json` are hand-duplicated and must agree.
- **`binary-smoke.sh` ownership:** it must signal and wait only through the stable Bash job spec captured for the exact child it started; the numeric PID is endpoint-identity evidence, never signal authority. Readiness rechecks both job liveness and the advertised PID. TERM/KILL cleanup is bounded, job eligibility is retired before `wait`, and any unowned/persistent endpoint preserves the data directory rather than deleting possibly-live state. The source and tests explicitly reject `pgrep`, `pkill`, and `killall`.
- **Data-dir isolation:** every compiled CLI/server invocation uses the same explicit directory while a sentinel `HOME` proves nothing touched the channel default. This smoke is the end-to-end proof that explicit directories neither migrate nor contaminate default state.
- **Worker headroom:** the normal lane keeps `maxWorkers: "50%"`; afterward, the state-root lock, spawn-lock, and archive-stale real-process-heavy files run one at a time in the serial one-worker project. Confirm the percentage behaves acceptably on small CI machines and that direct `scripts/*.test.ts` files remain typechecked and collected.
- **Four stable groups:** imports → exported classes/interfaces → other exports → private statements across configured `apps`, `packages`, and `examples` TypeScript/TSX files. Confirm import-equals, `export =`, `export as namespace`, default/abstract/declared forms, re-exports, and the empty `export {}` module marker land in the intended group without reordering declarations inside a group.
- **Autofix proof, not a purity guess:** runtime-bearing statements, module-source requests, and provider→consumer value dependencies constrain the preferred order. A fix is offered only when the stable topological result is fully grouped; otherwise `unsafeOrder` must report without changing text.
- **Text ownership and parse safety:** leading/member/trailing comments, tool directives, shebangs, prologues, CRLF, ASI continuation tokens, and shared-line prefix/suffix boundaries must either travel with a proven owner or disable the fix. A second `eslint . --fix` pass must produce no diff.
- **Migration equivalence:** the enabled rule found 55 files: one documented interface move was safely autofixed and 54 required reviewed moves, initializer IIFEs, direct-export conversions, hoisted private callables, or identity-preserving schema owners. Check public names, function/component bodies, eager order, allocation count, schema/layer identity, and published package boundaries rather than treating the migration as formatting.

**Best tests:** `test/eslint/module-order.test.mjs` (57 grouping, dependency, comment, directive, ASI, boundary, and idempotence cases), `effect-version-lockstep.test.ts`, `depcruise-exclude.test.ts`, `scripts/binary-smoke.test.ts` (the shell ownership/cleanup harness), and `scripts/binary-smoke.sh` itself. Also run `bun run lint`, then `bunx eslint . --fix` twice and require the second pass to leave no diff.

#### 7c — Project agent orchestration  ·  30–45 min  ·  🟡 medium

**What:** A checked-in seven-role roster for deterministic Claude/Codex delegation: `code-reviewer`, `task-reviewer`, `desktop-tester`, `manual-tester`, `tdd-implementer`, `researcher`, and `debugger`. The intended flow keeps the detailed Markdown definitions in `.claude/agents`, renders matching Codex TOML files, pins the controller and worker models/effort/sandboxes, and codifies the Superpowers hand-off rules in `AGENTS.md`.

**Why here:** This is repository execution policy rather than product runtime code. It determines who may edit, review, diagnose, and launch real processes, so review it after understanding the boundaries those agents are expected to preserve.

**Read in order:** `docs/superpowers/specs/2026-07-10-codex-claude-agent-roster-design.md` (approved design and data-dir amendment) → `AGENTS.md` (role selection, one-writer rule, task/final review gates, controller-only responsibilities) → `.codex/config.toml` (Sol Ultra controller, multi-agent enabled, four threads, depth one) → `scripts/sync-agents.ts` (canonical roster/policy map, validation, deterministic TOML rendering, check/write modes) → `.claude/agents/*.md` (the seven canonical role contracts) → `.codex/agents/*.toml` (the Codex mirrors) → `scripts/sync-agents.test.ts`.

**Scrutinize hardest:**
- **Pinned policy:** both reviewers are Claude Fable 5/xhigh and Codex Sol Ultra/read-only; the remaining roles are Claude Opus 4.8/xhigh and Codex Sol Medium with role-appropriate sandboxes. The controller stays Sol Ultra, concurrency is capped at four, delegation depth is one, workers cannot spawn workers, and parallel tracked-tree writers are forbidden.
- **Source-of-truth enforcement:** the sync tool must reject missing, duplicate, unexpected, incorrectly named, wrong-policy, or TOML-unsafe definitions; write mode must replace only expected files atomically and check mode must remain read-only.
- **Runtime tester safety:** both certification roles must use one explicit `--data-dir`, own processes through stable shell job specs, keep numeric PIDs as identity evidence only, bound shutdown, and preserve state whenever ownership becomes uncertain.

**Best tests:** `scripts/sync-agents.test.ts` (roster, policy, parser, safe rendering, stale/missing/unexpected-file behavior) and `bun run agents:check` (the repository-level drift gate).

---

## The fast path (4–5 hours)

If you can't do the full pass, review the **load-bearing correctness cores** in this order — these are where a real bug would do the most damage:

1. **Stage 0** — the four invariants (20 min). Non-negotiable context.
2. **`contracts/project.ts`** — the single shared fold (20 min). If this is wrong, everything diverges.
3. **`contracts/app-context.ts` → CLI `main.ts` → client `spawn-lock.ts` → server `startup-ownership.ts`/migration → `state-root-lock.ts` → `binary-smoke.sh`** — trace one explicit data directory end to end, including external-default/root-local coordination, legacy-home safety, and runtime ownership (45–60 min).
4. **`server/application/projects/use-cases.ts` + `rpc-handlers.ts`** — the mutex + `fromSeq` replay (the replay handler body is `apps/server/rpc/stream.ts`) (45 min). The write path and stream correctness.
5. **`client-ts/project/store.ts`** — the C2 atomic snapshot + bootstrap window (45 min). The read path every UI shares.
6. **`electron-ipc/main.ts` + `desktop/src/main/security/origin-rules.ts`** — the renderer trust boundary (40 min). *Skip if desktop is out of scope.*
7. **`test/architecture/i1-cli-isolation.test.ts` + `.dependency-cruiser.cjs`** — confirm the invariants are actually enforced, not just asserted (20 min).
8. **`eslint-rules/module-order-analysis.mjs` + `test/eslint/module-order.test.mjs`** — verify that unsafe runtime/comment boundaries report without fixing and safe outputs are idempotent (20 min).
9. **`AGENTS.md` + `scripts/sync-agents.ts` + `bun run agents:check`** — verify the role/policy mirror (25 min).

Reading the matching "best tests" alongside each gives you the intended behavior fast.

---

## At-a-glance summary

| Stage | Module | Layer | Complexity | Time |
|---|---|---|---|---|
| 0 | architecture docs | foundation | 🟢 | ~20 min |
| 1 | `packages/contracts` | foundation | 🟡 | 35–45 min |
| 2 | `apps/server` | backend | 🔴 | 75–90 min |
| 3 | `packages/client-ts` | shared client | 🔴 | 75–90 min |
| 4 | `apps/cli` | frontend | 🟢 | 30–45 min |
| 5a | `packages/ink-input` | shared client | 🟢 | 20–30 min |
| 5b | `apps/tui` | frontend | 🟡 | 40–55 min |
| 6a | `packages/electron-ipc` | boundary | 🔴 | 75–90 min |
| 6b | `apps/desktop` (main) | boundary | 🔴 | 45–60 min |
| 6c | `apps/desktop` (renderer) | frontend | 🔴 | 75–90 min |
| 7a | `test/architecture` | enforcement | 🟢 | 30–45 min |
| 7b | infra + module ordering | infra | 🟡 | 45–60 min |
| 7c | project agent orchestration | infra | 🟡 | 30–45 min |

**Golden thread to hold throughout:** *one* backend owns each selected state root; *one* fold derives it; clients only mirror the sequenced event stream; I-1 confines backend construction statically; and `backend.lock` enforces runtime uniqueness. If a change in any module would let two writers share a state root, let a frontend bypass client-ts ownership, or let a snapshot disagree with a replay — that's the bug worth finding.
