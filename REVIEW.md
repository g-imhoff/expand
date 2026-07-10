# Reviewing `feat/architectural-foundation`

A guided reading path for reviewing this branch. It is large — **438 commits, 343 files, ~22,300 insertions and only 60 deletions** — so treat everything here as *newly built*, not as a small diff on top of `develop`.

This guide orders the review by the **dependency graph**: you read each layer only after the layers it is built on. By the time you reach a frontend, you already understand the vocabulary, the backend, and the connection logic it relies on, so nothing is reviewed in a vacuum.

> **How to use this**
> - Each stage has a *plain-language summary*, *why it comes here*, a *file-by-file reading order*, the *handful of things worth scrutinizing hardest*, and the *tests that best prove intent*.
> - Time estimates are for a careful human review. The full path is ~9–11 hours. If you can't spend that, jump to **[The fast path](#the-fast-path-3-4-hours)**.
> - The whole branch is built to satisfy four load-bearing invariants (**I-1 … I-4**). Stage 0 explains them; every later stage references them.

---

## The big picture (read this first)

Expand is an AI-assisted dev-workflow tool. This branch lays its **architectural skeleton**: a strictly layered monorepo (Bun + **Effect v4 beta** — framework code lives under `effect/unstable/*`) where exactly **one** process owns all state and every UI is a thin client.

```
                      packages/contracts          ← shared vocabulary (schemas, RPC, events)
                            │  (everyone imports this, it imports no one)
        ┌───────────────────┼─────────────────────────────┐
        ▼                                                   ▼
   apps/server   ── the ONE backend ──┐          packages/client-ts
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
| **I-2** | One AppLayer per machine | Only `apps/server` hosts the Effect `AppLayer` (the DB, event bus, subprocesses). Everyone else is a client. |
| **I-3** | Single discovery file | The backend writes one endpoint file (`url`, `token`, `pid`, `protocolVersion`) on boot; clients find-or-spawn through it. |
| **I-4** | Zero-connection shutdown | The backend counts live WebSocket connections; the instant the count returns to 0, it shuts down. No grace period. |

**Recurring themes** worth understanding once, because they appear in almost every module:

- **Event sourcing + one shared fold.** The backend stores immutable domain events; current project state is *derived* by folding them. The fold lives in **one place** (`Project.foldList` in contracts) and is reused verbatim by the server *and* every client — so a snapshot can never disagree with a replayed stream.
- **Server read-model cache (optimization).** The server no longer re-folds the whole log on every read. It keeps an **in-memory live read model** (a `SubscriptionRef`) seeded at boot from a **persisted `projection_state` row** (name-keyed: serialized state + `last_seq` + per-projection fold version) and advanced per commit — reads are O(rows), boot is O(tail-since-checkpoint). Checkpoints are written at boot, **debounced during the session (500ms quiet)**, and **once more at I-4 shutdown**, so a boot's tail is bounded by the debounce window after a crash and ~empty after a graceful cycle. The row is a disposable cache stamped with `FOLD_VERSIONS.projects` (rebuild-from-zero on mismatch) and proven equal to a full replay by `snapshot-equivalence.test.ts` — *snapshot can never disagree with replay* still holds as a **checked invariant**. See `docs/architecture/decisions/2026-07-05-event-store-foundation-design.md`.
- **Protocol v2.** Clients bootstrap by (1) subscribing to the `Events` stream *first*, (2) seeding from a `{projects, seq}` snapshot, (3) gating the live fold by `seq`. This avoids losing or double-applying events during the bootstrap window.
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

**What:** The shared vocabulary every other package imports and nothing imports back: branded scalars, the domain event union, the canonical `Project` read-model with its fold logic, the RPC surface, the discovery-file schema, and the CLI output envelopes.

**Why here:** It is the foundation (`dependsOn: none`). Every later module speaks this language.

**Read in order:**
DONE (2026-07-05: fold versions became per-projection — re-read the FOLD_VERSIONS part; 2026-07-07: the fold is now ONLY Project.foldList — server/domain/project.ts removed) 1. `project.ts` — **start here.** Branded scalars + the opaque `Project` and its canonical statics `fromCreated` / `applyEvent` / `foldList`. *This fold is the single source of truth reused by server and clients alike.* Also drives **`FOLD_VERSIONS`** — a per-projection map (name → build-time SHA-256 of that projection's fold nodes; `projects` hashes the `Project` class), generated into `packages/contracts/fold-version.generated.ts` by `scripts/fold-version.ts` (`bun run gen:fold-version`). The server stamps `FOLD_VERSIONS.projects` on the persisted `projection_state` row; a mismatch forces a from-zero rebuild. It changes automatically when the fold changes — no manual bump (pinned by `test/architecture/fold-version-lockstep.test.ts`).
DONE 2. `events/meta.ts` — tiny `withMeta()` helper that gives every event a common envelope.
DONE 3. `events/project.ts` — the 7 event variants (Created/Renamed/DirectoryChanged/Archived/Restored/MetadataChanged/Deleted).
DONE 4. `events/domain.ts` — assembles the `DomainEvent` union, the JSON wire codec, and the `SequencedEvent {seq, event}` envelope.
DONE 5. `rpc.ts` — the `ExpandRpcs` group + tagged errors. Focus on Protocol v2: `ProjectList → {projects, seq}` and the `stream:true` `Events`/`Connect` RPCs with `fromSeq`.
DONE 6. `endpoint.ts` — discovery-file schema + `PROTOCOL_VERSION = 2` (I-3).
MOVED 7. `cli.ts` — the stable `expand/v1` JSON envelopes the CLI prints.

**Scrutinize hardest:**
- **Single fold, no second copy.** Confirm `foldList`/`applyEvent` here are genuinely the *only* projection and that server + client-ts reuse them (any divergence breaks snapshot-vs-replay consistency).
- **`applyEvent` semantics:** `MetadataChanged` is a partial patch keyed on `!== undefined` (omission keeps a field; `null` clears it). Tags dedupe via `new Set`. Check `undefined` vs `null` intent.
- **`foldList` replay-safety:** create is idempotent, delete tombstones, unknown ids are no-ops — must match how the server sequences and the client gates by `seq`.
- **Validation bounds are the system trust boundary:** name/tag regex, UUIDv4 ids, description ≤ 2048, directory ≤ 4096 — the *same* limits must apply on both the event and RPC schemas.
- **`PROTOCOL_VERSION` coupling:** any shape change must bump the version (clients reject mismatches).

**Best tests to read:** `test/project-fold.test.ts` (the projection), `test/events.test.ts` (round-trips + legacy decode), `test/rpc.test.ts` (validation at the RPC boundary).

---

### Stage 2 — `apps/server`  ·  75–90 min  ·  🔴 high

**What:** The single authoritative backend (I-2). An event-sourced service: mutations append immutable events to a SQLite log (monotonic `seq`); the read-model is an **in-memory live projection seeded at boot from a persisted snapshot** (folded from the log only for the tail since that snapshot, or from zero on first boot / `FOLD_VERSIONS.projects` mismatch), and it's all served over a token-guarded, loopback-only WebSocket RPC. Writes the endpoint file on boot (I-3); self-shuts-down at zero connections (I-4).

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
DONE 9. `composition/app.ts` → `main.ts` — lifecycle orchestration and the thin entrypoint; also the **on-disk hardening**: `main.ts` sets `process.umask(0o077)` before anything touches the filesystem, and `app.ts` fail-closed-`chmod`s the data dir (`0700`), the SQLite log (`0600`), and the WAL/SHM sidecars if present (`secureIfPresent`).

**Scrutinize hardest:**
- **Concurrency:** the single `Semaphore(1)` is the *only* thing serializing read-validate-commit. Confirm every mutating use-case goes through it and uniqueness/"exactly-one-winner" guards can't be bypassed.
- **`fromSeq` replay seam** (`apps/server/rpc/stream.ts`, composed into `rpc-handlers.ts`): subscribe → read backlog → filter live by `seq > lastReplayed`. Verify **no gap or duplicate** between backlog tail and first live event under concurrent appends. The backlog is now STREAMED (`ReplayFeed.read`), so `lastReplayed` is a `Ref` initialized to `fromSeq` and advanced as the backlog flows; the live filter reads it only after `Stream.concat` switches over.
- **`commit()`:** append (SQLite) + publish (PubSub) are two systems wrapped in `uninterruptible`. A failure between them desyncs bus from log — confirm "log is source of truth, bus is best-effort" is intended.
- **Fail-fast decode:** `scan` dies on any undecodable row (defect names seq/stream_id/event_type). This deliberately REVERSES the earlier skip-with-warning trade-off (ADR 2026-07-05): silently-vanishing projects were judged worse than a refusing boot. Verify the defect carries enough context to act on, and that no caller re-introduces a silent skip.
- **The read-model cache:** confirm the four guards that keep the persisted state equal to a replay — (1) checkpoints are written only by the projection's own scope (boot save, the debounce fiber reading consistent C2 pairs, and the shutdown finalizer — commit path writes NOTHING to projection_state), (2) each row is stamped at the state's own `seq`, (3) tail catch-up and from-zero rebuild both go through the same shared fold, and (4) a `FOLD_VERSIONS.projects` mismatch forces a from-zero rebuild. Also verify the finalizer-before-fiber registration order (teardown must interrupt the fiber BEFORE the final write).
- **On-disk secrecy** (`main.ts` + `composition/app.ts`): the endpoint file carries the loopback auth token and the SQLite log carries every event, so both must stay group/world-unreadable. `umask(0o077)` narrows the default creation mode and the fail-closed `chmod`s tighten anything already on disk. Confirm the `umask` is set *before* any file is created (it runs before the runtime boots), and that `secureIfPresent` genuinely narrows the WAL/SHM sidecars once they exist rather than silently skipping them.

**Best tests to read:** `test/integration/concurrency.test.ts`, `test/integration/events-replay.test.ts`, `test/integration/durability-restart.test.ts` (snapshot advances across a restart; the checkpoint-write cadence itself is pinned by the checkpoint-cadence tests in `projection.test.ts`), `test/integration/trust-boundary.test.ts`, `test/integration/snapshot-equivalence.test.ts` (the proof that state@k+tail == fold-from-zero), `test/integration/projection-state-store.test.ts`, `test/integration/project-event-store.test.ts`, `test/integration/replay-feed.test.ts`, the boot-matrix + checkpoint-cadence tests in `test/integration/projection.test.ts`, and `test/integration/events-handler.test.ts` (the streamed-backlog dedup gate).

---

### Stage 3 — `packages/client-ts`  ·  75–90 min  ·  🔴 high

**What:** The "connection brain" shared by all three frontends: a platform seam (Bun/Node), find-or-spawn discovery, the RPC session + presence handshake, and the reactive `ProjectStore` that mirrors backend state and survives reconnects. Hosts no `AppLayer` (I-2); reaches the backend only via the discovery file (I-3) and never imports `apps/server` (I-1). Its public API is a **curated, Effect-native SDK surface**: external code enters *only* through the scoped entrypoints — `@expand/client-ts` (connection core), `@expand/client-ts/project`, `@expand/client-ts/server`, and `@expand/client-ts/adapters/{bun,node}` — every other module is internal (tagged `@internal`) and made unreachable from outside by the `client-ts-barrel-only` dependency-cruiser rule (see Stage 7).

**Why here:** Depends on `contracts` + `server`; consumed by every frontend. The CLI/TUI/desktop chapters are short because this is where their real logic lives.

**Read in order:** *(public entrypoints = `index.ts`/`project.ts`/`server.ts` + `adapters/{bun,node}`; everything else is package-internal)*
1. `ARCHITECTURE.md` — **read first**, the author's own line-referenced walkthrough. Its "Public API surface" section is the map of what each entrypoint (root, `/project`, `/server`, `adapters/*`) exports and what is `@internal`.
2. `index.ts` + `project.ts` + `server.ts` — the public entrypoints: root = strict connection core; the domain surfaces live on the `/project` and `/server` subpaths (one canonical import path per symbol).
3. `adapter.ts` — the 2-member `RuntimeAdapter` platform seam.
4. `discovery.ts` — endpoint gating, the `O_EXCL` lock dance + stale-lock recovery, find-or-spawn.
5. `rpc-client.ts` — `acquireClient`: builds the protocol layer, the presence handshake, stale-endpoint self-healing retry.
6. `adapters/bun.ts` + `adapters/node.ts` — the two platform implementations (socket + spawn); the platform subpath entrypoints (public alongside `/project` and `/server`).
7. `project-store.ts` — **the core engine:** the session loop, the **C2 atomic fold**, the public mirror, the reconnect loop, and the mutation methods.
8. `supervise.ts` — logs a background fiber's death unless it was a clean interrupt.
9. `project-client.ts` + `client-layer.ts` — the stateless facades and how layers share one connection.

**Scrutinize hardest:**
- **The C2 atomic fold** (`project-store.ts`): `{projects, seq}` live in one `SubscriptionRef` mutated together (gate `seq <= s.seq` → `foldList` → bump seq → publish), so a reader can never see a `seq` ahead of its `projects`. This is the central correctness claim.
- **Bootstrap window ordering:** Events subscribed *before* `ProjectList`, `Math.max` on seq, one-time seed before signalling ready. An off-by-one silently loses or double-applies events.
- **Stale-lock recovery** (`discovery.ts`): the dead-pid/30s heuristic and `ensuring(releaseLock)` — a crashed spawner used to wedge every future client.
- **Reconnect classification** (`project-store.ts`): `Cause.hasInterruptsOnly` must separate deliberate shutdown (propagate) from a dropped socket (retry with backoff). Misclassifying either hangs or busy-loops.
- **Non-optimistic state:** mutations only call the RPC; state changes only when the server's event flows back. Confirm there's no optimistic local write.
- **Entrypoint boundary** (`index.ts`/`project.ts`/`server.ts` + the `client-ts-barrel-only` rule): external code must reach the package only via the entrypoints; internals are `@internal` and depcruise-forbidden from outside. Confirm the rule is non-vacuous (it flags a real deep import) and note its one blind spot — depcruise excludes `test/`, so the rule does not police test files (all current out-of-package tests go through the public entrypoints; client-ts's own tests deliberately deep-import internals relatively).

**Best tests to read:** `test/integration/snapshot-consistency.test.ts` (the C2 proof — 40 concurrent reads), `test/integration/bootstrap-window.test.ts`, `test/integration/reconnect.test.ts`, `test/integration/cross-store-sync.test.ts`, `test/architecture/client-ts-barrel.test.ts` (the public-API boundary), `packages/client-ts/test/unit/entrypoints.test.ts` (pins the `/project` + `/server` surfaces and the strict-core root — domain symbols must NOT be reachable from `@expand/client-ts`).

**Dogfood the public surface — `examples/client-ts/`:** three runnable real-world programs written as an *external consumer* would — `bootstrap-projects.ts` (create a project per subfolder, deduping/skipping conflicts), `archive-stale.ts` (archive projects whose directory has vanished), and `audit-log.ts` (tail `ProjectStore.events` to a JSONL file). Every import comes only from the public entrypoints (`@expand/client-ts`, `@expand/client-ts/project`, `@expand/client-ts/adapters/bun`) — the `client-ts-barrel-only` rule (Stage 7) now covers this directory, so a deep import into a package internal fails CI, and each example has a subprocess smoke test in `examples/client-ts/test/` that runs it against an isolated backend. **Read `examples/client-ts/ERGONOMICS.md` alongside this stage** — it is a file-referenced list of what felt awkward to build against the SDK (which command surface to reach for and why, boilerplate the SDK doesn't yet absorb, and where the "public API only" promise leaks). It is the concrete output of this dogfooding pass and the best single signal of whether the `client-ts` shape is right.

---

### Stage 4 — `apps/cli`  ·  30–45 min  ·  🟢 low

**What:** A thin, agent-friendly CLI that turns shell verbs into typed RPC calls and prints stable, versioned JSON envelopes (`apiVersion "expand/v1"`) with distinct per-error exit codes. Holds no business logic.

**Why here:** It's the **simplest complete frontend** — review it first among the UIs to see the full `frontend → client-ts → RPC → backend` loop without any UI complexity.

**Read in order:**
1. `cli/main.ts` — composition root: builds the command tree, wires the real Bun client layer, installs the JSON error formatter (`makeExpand` factory + `import.meta.main` guard).
2. `cli/_command.ts` — the `defineCommand` seam every verb flows through (envelope/text/quiet rendering).
3. `cli/output.ts` + `cli/global-flags.ts` — stdout/stderr discipline and the `--format`/`--quiet` flags.
4. `packages/contracts/cli.ts` — the envelope schemas being hand-built.
5. `cli/commands/project/create.ts` — a representative command (the pattern all verbs follow).
6. `cli/commands/project/_resolve.ts` — name-or-UUID target resolution.
7. `cli/errors/index.ts` + `cli/errors/project-errors.ts` + `cli/run.ts` — the contract-error → CLI-error mapping (stable codes/exit codes) and the top-level error boundary.

**Scrutinize hardest:**
- **Error-mapping fidelity:** unmapped `_tag`s silently fall through to `UNEXPECTED` (exit 1) — verify the switch tables cover the real contract error set.
- **Exit codes are an external API** for scripting agents — confirm codes (1/2/5/6/7/8/9/10) and `retryable` flags are stable and tested.
- **stdout/stderr purity:** a failure must emit nothing on stdout and exactly one JSON line on stderr.
- **Envelopes are hand-built** (not `Schema.encode`d), so drift vs `contracts/cli.ts` is possible — the snapshot/contract tests are the safety net.

**Best tests to read:** `test/contract/contract.test.ts` (the behavioral matrix), `test/unit/errors.test.ts`, `test/unit/envelope-schema.test.ts` (freezes the output contract).

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

**Read in order:** `src/shared/ipc/channels.ts` → `src/preload/index.ts` → `src/main/runtime.ts` (proves main is a client) → `src/main/index.ts` (the wiring hub: CSP, hardened `webPreferences`, navigation denial, `rpcPort` handler) → `src/main/rpc/server.ts` (`makePortProtocol` adapts `MessagePortMain` into an `RpcServer.Protocol`) → `src/main/rpc/transport.ts` → `src/main/rpc/handlers.ts` → `src/main/rpc/project-handlers.ts` (the proxy logic) → `src/main/rpc/connection-handlers.ts` (Connect status mirror + Events `fromSeq` gating) → `src/main/security/window-options.ts` + `ipc/origin-rules.ts` + `ipc/port-lifecycle.ts`.

**Scrutinize hardest:**
- **Security pipeline completeness:** CSP only in prod, the `sandbox`/`contextIsolation`/`nodeIntegration` pin, navigation/window-open denial, and — load-bearing — that the dev `exactOrigin` carve-out can **never** reach a production build (prod is `file://`-only).
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

### Stage 7 — Enforcement & infra  ·  60–90 min

The capstone: how the invariants you've been tracking are *mechanically* guaranteed. Reviewing this last lets you judge whether the tests actually pin what the earlier stages claimed.

#### 7a — `test/architecture`  ·  30–45 min  ·  🟢 low

**What:** Eleven "fitness tests" that turn the prose invariants into build failures. They run `dependency-cruiser` programmatically *and* do their own filesystem/source-text assertions, with DO-NOT-MODIFY headers + CODEOWNERS routing so the rules can't be quietly relaxed.

**Read in order:** `docs/architecture/BOUNDARIES.md` (re-anchor) → `.dependency-cruiser.cjs` → `i1-cli-isolation.test.ts` (the flagship I-1 test) → `depcruise-exclude.test.ts` (the guard on the guard) → `client-ts-barrel.test.ts` (pins the `client-ts` public API — only the four entrypoint kinds `index.ts`/`project.ts`/`server.ts`/`adapters/*` are importable from outside; asserts the `client-ts-barrel-only` rule's exact `from`/`to` shape and a clean cruise) → `ipc-boundary.test.ts` → `tui-input-boundary.test.ts` → `server-app-split.test.ts` → `backend-ownership.test.ts` → `fold-version-lockstep.test.ts` (recomputes the per-projection fold-node hashes via `scripts/fold-version.ts` and asserts the committed `FOLD_VERSIONS` is current — the build fails until you `bun run gen:fold-version` and commit) → `no-dead-code.test.ts` (runs **Knip** over both workspaces and fails on any unused file / export / exported type / dependency — the standing "no dead code" gate; config and every suppression are justified in `knip.jsonc`).

**Scrutinize hardest:**
- **Non-vacuity:** do the depcruise-backed tests actually *fail* when a real forbidden import is introduced (not just assert a name is absent + exit 0)?
- **Greps are coarse/bypassable:** substring matches (`/\buseInput\b/`, `/from "electron"/`) can be evaded by aliasing or dynamic `import()` — confirm a depcruise rule backstops each grep.
- **Hardcoded path lists go stale silently:** `SERVER_FILES`, the allowed-adapters set, the pure-module lists — a renamed file weakens the check without failing it.

**Best tests:** `i1-cli-isolation.test.ts`, `depcruise-exclude.test.ts`, `test-colocation.test.ts`.

#### 7b — Infra (root config)  ·  30–45 min  ·  🟡 medium

**What:** The build/CI/enforcement plumbing that makes all of the above checkable: the dependency-cruiser rules, the GitHub Actions pipeline, the TS/Vitest path aliases, the exact dependency pins, and the compiled-binary smoke test.

**Read in order:** `.dependency-cruiser.cjs` (the eight forbidden import rules — the I-1 engine in code, now including `client-ts-barrel-only`, the `client-ts` public-API boundary) → `.github/workflows/ci.yml` (checks → parallel desktop-e2e + binary-smoke) → `scripts/binary-smoke.sh` (certifies the *compiled* binaries; proves I-4 reaping via `pgrep` poll) → `package.json` (scripts + exact Effect v4 beta pins) → `knip.jsonc` (the dead-code gate's config: the two workspaces, the narrow type/interface used-in-file allowance, and the documented `ws`/`@types/ws` cross-workspace false-positive suppression) → `tsconfig.json` + `vitest.config.ts` (the **duplicated** `@expand/*` alias maps) → `CODEOWNERS`.

**Scrutinize hardest:**
- **Glob completeness** in `.dependency-cruiser.cjs`: a new frontend or renamed path would silently escape I-1.
- **Alias drift:** `tsconfig.json` paths, `vitest.config.ts` `resolve.alias`, and `apps/desktop/tsconfig.json` are hand-duplicated and must agree.
- **`binary-smoke.sh` can't false-pass:** verify the I-4 reaping check genuinely depends on the connection count hitting zero (not on the server never starting).

**Best tests:** `effect-version-lockstep.test.ts`, `depcruise-exclude.test.ts`, and `scripts/binary-smoke.sh` itself.

---

## The fast path (3–4 hours)

If you can't do the full pass, review the **load-bearing correctness cores** in this order — these are where a real bug would do the most damage:

1. **Stage 0** — the four invariants (20 min). Non-negotiable context.
2. **`contracts/project.ts`** — the single shared fold (20 min). If this is wrong, everything diverges.
3. **`server/application/projects/use-cases.ts` + `rpc-handlers.ts`** — the mutex + `fromSeq` replay (the replay handler body is `apps/server/rpc/stream.ts`) (45 min). The write path and stream correctness.
4. **`client-ts/project-store.ts`** — the C2 atomic snapshot + bootstrap window (45 min). The read path every UI shares.
5. **`electron-ipc/main.ts` + `desktop/src/main/security/origin-rules.ts`** — the renderer trust boundary (40 min). *Skip if desktop is out of scope.*
6. **`test/architecture/i1-cli-isolation.test.ts` + `.dependency-cruiser.cjs`** — confirm the invariants are actually enforced, not just asserted (20 min).

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
| 7b | infra (root config) | infra | 🟡 | 30–45 min |

**Golden thread to hold throughout:** *one* backend owns state; *one* fold derives it; clients only mirror the sequenced event stream; and the import graph (I-1) is what physically keeps it that way. If a change in any module would let a second writer exist, let a frontend boot its own backend, or let a snapshot disagree with a replay — that's the bug worth finding.
