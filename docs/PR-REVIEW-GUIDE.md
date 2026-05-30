# PR Review Guide — `feat/architectural-foundation` → `develop`

> A companion for reviewing the Yodea architectural-foundation PR: the CLI-only walking
> skeleton on Effect v4 beta. It explains **what** to look at, in **what order**, **why**
> each decision was made, and — most importantly — **where the bodies are buried** so a
> reviewer can find real issues fast.

---

## Table of contents

1. [Purpose & how to use this guide](#1-purpose--how-to-use-this-guide)
2. [TL;DR](#2-tldr)
3. [Architecture overview](#3-architecture-overview)
4. [Suggested reading order](#4-suggested-reading-order)
5. [Subsystem walkthroughs](#5-subsystem-walkthroughs)
6. [Invariant enforcement map (I-1..I-4)](#6-invariant-enforcement-map-i-1i-4)
7. [Deviations from the plan & runtime integration fixes](#7-deviations-from-the-plan--runtime-integration-fixes)
8. [POTENTIAL ISSUES & REVIEW HOTSPOTS](#8-potential-issues--review-hotspots)
9. [Known limitations & deliberately deferred scope](#9-known-limitations--deliberately-deferred-scope)
10. [Reviewer checklist & commands](#10-reviewer-checklist--commands)

---

## 1. Purpose & how to use this guide

This document is a **review companion**, not a spec. Read [§2](#2-tldr) and [§3](#3-architecture-overview)
to load the mental model, then review the code in the dependency order of [§4](#4-suggested-reading-order)
using the [§5](#5-subsystem-walkthroughs) walkthroughs as a per-file map. When you want to
*find problems* (the point of a review), jump straight to **[§8 Potential Issues](#8-potential-issues--review-hotspots)** —
it is prioritized, de-duplicated, and gives `file:line` + "what to check" for every concern
surfaced across six independent subsystem reviews plus the author's own known-limitations list.

The PR is small and dense: **906 lines of production TypeScript across 21 files**, plus 724
lines of tests across 18 files. Every file is short. You can genuinely read all of it. Use
[§6](#6-invariant-enforcement-map-i-1i-4) to *verify* the four load-bearing invariants yourself
with copy-pasteable commands, and [§10](#10-reviewer-checklist--commands) as the final gate.

The four invariants are specified normatively in [`docs/architecture/BOUNDARIES.md`](architecture/BOUNDARIES.md)
— that file is the source of truth for what the rules *mean*; this guide is about whether the
code *honors* them.

---

## 2. TL;DR

**What this PR is.** The complete walking skeleton of Yodea's architecture: a single backend
process that many frontends connect to over WebSocket RPC, built on **Effect v4 beta
(`4.0.0-beta.74`)**, with event-sourcing + CQRS at the core. The only frontend in this PR is a
thin CLI client. It proves every architectural seam end-to-end while deliberately deferring all
real features (no desktop, no agents, no real services).

**Scope.** CLI-only walking skeleton. One domain event (`ProjectCreated`), one read-model
(`Project`), five RPC procedures (`Health`, `ProjectCreate`, `ProjectList`, `Connect`, `Events`).
Everything else is structural scaffolding designed to flex as features are added.

**Headline numbers** (verified on this machine after the [C1](#8-potential-issues--review-hotspots) test-timeout fix):

| Metric | Value |
| --- | --- |
| Commits on branch | ~39 (`develop..HEAD`) |
| Production source | 21 files / 906 LOC |
| Tests | 18 files / 724 LOC — **33 pass / 0 fail**, reliably green ×5 after the C1 fix |
| `tsc --noEmit` | exit 0 (strict + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`) |
| `bun run arch` | 0 dependency-cruiser violations |
| `bun run build` | `dist/yodea`, single ~101 MB binary, 351 modules |

**The four invariants, one line each:**

- **I-1 — CLI client isolation.** `apps/cli/cli/**` must never import a server-only module; the only allowed connection to backend state is RPC. (Sole exception: `cli/commands/server.ts` may import `composition/`.)
- **I-2 — Single AppLayer per machine.** At most one backend process, built from one `runServer` AppLayer, owning one SQLite handle, one EventBus, one ConnectionTracker.
- **I-3 — Single discovery file.** Exactly one well-known `server.json` written on startup and removed on shutdown; it is the only rendezvous between client and server.
- **I-4 — Zero-connection self-shutdown.** Once the server has had ≥1 WebSocket connection, it self-terminates the moment the connection count returns to 0.

---

## 3. Architecture overview

### One backend, many frontends

The whole design exists to avoid two failure modes:

- **Desync / data divergence.** If each CLI invocation booted its own in-process backend, each
  would write its own SQLite, run its own event bus, and (eventually) spawn its own agent
  subprocesses — and the desktop UI would never see any of it. **I-1** + **I-2** make this
  physically impossible: there is one backend, and frontends *talk to it*, they don't *become* it.
- **Cold-start cost & zombie accumulation.** Booting Effect + opening SQLite on every `yodea`
  command is wasteful, and a long-lived daemon that never dies leaks resources. **I-3** (rendezvous)
  + **I-4** (self-shutdown) give a daemon that is spawned on demand, shared while needed, and
  reaped the instant the last client leaves.

So: the backend is a singleton daemon. A frontend **discovers** it via `server.json`, **spawns**
it (under an exclusive lock) if absent, **connects** over WebSocket, does its RPC work, and
**drops** the connection — which is itself the signal that may let the daemon die.

### Event-sourcing / CQRS flow

State changes follow a strict pipeline. The **durable append is the commit point**; the live
broadcast is best-effort:

```
command (ProjectCreate RPC)
   │
   ▼
use-case: createProject(name)
   │  build ProjectCreated event
   ├─► EventStore.append  ──►  SQLite events table (ORDER BY seq = source of truth)   [COMMIT POINT]
   │
   └─► EventBus.publish   ──►  in-memory PubSub  ──►  Events stream (live frontends)   [best-effort]

query (ProjectList RPC)
   │
   ▼
ProjectProjection.list ──► EventStore.readAll ──► projectsFromEvents(events) fold ──► [Project]
                           (re-read + re-fold the whole log on every query)
```

The log is canonical; projections are derived by folding it. There is **no projection cache**
and **no historical replay on the `Events` stream** (live-only) — both deliberate for the
skeleton.

### A request, end to end

```
 yodea project create "alpha"
        │
        ▼
 findOrSpawnBackend ──► readEndpoint(server.json)?
        │                   ├─ Some(live) ─────────────► use it
        │                   └─ None ─► tryAcquireLock (O_EXCL) ─► spawn `dist/yodea server` (detached, unref)
        │                                                          └─ awaitEndpoint (poll server.json, 5s budget)
        ▼
 RpcClient.make over ws://127.0.0.1:<ephemeral>/rpc
        │
        ├─ fork Connect() stream  ─────► server: tracker.onConnect (count 1, ARMED)
        │     (held for whole scope)               emits one `true`  ─► client resolves `ready`
        │
        ├─ ProjectCreate({name}) ──────► append + publish ─► returns Project
        │
        ▼  scope closes (command done)
 Connect() scope drops ─────────────► server: onDisconnect (count 0 & armed) ─► awaitShutdown fires (I-4)
                                                 │
                                                 ├─ eager: remove server.json (I-3)  [before grace window]
                                                 └─ close transport (bounded ~1s grace) ─► process.exit(0)
```

### The discovery / lifetime dance (why each piece exists)

```
       ┌──────────── client A ────────────┐         ┌──────────── client B ───────────┐
       │ read server.json → None          │         │ read server.json → Some(live)    │
       │ acquire .lock (O_EXCL) — WINS     │         │ (or waits on awaitEndpoint)      │
       │ spawn server, await endpoint      │         │ connect, do work, drop           │
       └───────────────┬──────────────────┘         └───────────────┬──────────────────┘
                       │ (lock prevents 2nd spawn = I-2)             │
                       ▼                                             ▼
                 ┌────────────────────── one backend ──────────────────────┐
                 │ writes server.json (I-3) AFTER the port is bound          │
                 │ ConnectionTracker: armed-on-first-connect, fire at 0 (I-4)│
                 │ ephemeral port → no EADDRINUSE during overlapping teardown│
                 └──────────────────────────────────────────────────────────┘
```

Ephemeral port + eager `server.json` removal + a bounded client connect-timeout are the three
fixes that make *back-to-back* commands reliable despite the ~1s graceful-stop window (see [§7](#7-deviations-from-the-plan--runtime-integration-fixes)).

---

## 4. Suggested reading order

Review in dependency order — contracts first (everything depends on them), then the core, then
the server, then composition, then the CLI, then tests. One line per file: **path · responsibility · LOC**.

### Shared contracts + lib (pure, I-1-safe import targets)

| # | File | Responsibility | LOC |
| --- | --- | --- | --- |
| 1 | `apps/cli/lib/ids.ts` | `newId()` = `crypto.randomUUID()` | 1 |
| 2 | `apps/cli/shared/project.ts` | `Project` read-model schema (plain Struct) | 8 |
| 3 | `apps/cli/shared/events.ts` | `ProjectCreated`/`DomainEvent` + `DomainEventFromJson` codec | 17 |
| 4 | `apps/cli/shared/endpoint.ts` | `Endpoint` schema, `PROTOCOL_VERSION`, `endpointFilePath()` (I-3 contract) | 21 |
| 5 | `apps/cli/shared/rpc.ts` | `YodeaRpcs` RpcGroup — the single client↔server protocol | 23 |

### Event-sourced core (storage → domain → application)

| # | File | Responsibility | LOC |
| --- | --- | --- | --- |
| 6 | `apps/cli/db/event-store.ts` | append-only SQLite event log (source of truth, `ORDER BY seq`) | 54 |
| 7 | `apps/cli/domain/project.ts` | pure `projectsFromEvents` fold (events → read-model) | 23 |
| 8 | `apps/cli/application/projections.ts` | `ProjectProjection` binding the fold to the live log | 23 |
| 9 | `apps/cli/application/event-bus.ts` | `EventBus` PubSub broadcast (live fan-out) | 25 |
| 10 | `apps/cli/application/use-cases.ts` | `createProject` (append-then-publish), `listProjects`, `health` | 45 |

### Server transport + lifetime

| # | File | Responsibility | LOC |
| --- | --- | --- | --- |
| 11 | `apps/cli/server/connection-tracker.ts` | I-4 state machine (arm-on-first-connect, fire-at-zero) | 40 |
| 12 | `apps/cli/server/rpc-handlers.ts` | maps `YodeaRpcs` → use-cases; `Connect` presence handler | 32 |
| 13 | `apps/cli/server/endpoint-file.ts` | I-3 acquireRelease: write `server.json` / remove on close | 22 |
| 14 | `apps/cli/server/http.ts` | WebSocket/NDJSON RPC transport + 499-demoting access logger | 86 |

### Composition (single construction site — read carefully)

| # | File | Responsibility | LOC |
| --- | --- | --- | --- |
| 15 | `apps/cli/composition/app.ts` | `coreLayer` (I-2 single graph) + `runServer` lifecycle (I-3/I-4) | 134 |

### CLI thin client (I-1)

| # | File | Responsibility | LOC |
| --- | --- | --- | --- |
| 16 | `apps/cli/cli/discovery.ts` | `readEndpoint`, find-or-spawn-under-lock, stale-lock recovery | 176 |
| 17 | `apps/cli/cli/rpc-client.ts` | `withClient`: connect, hold presence channel, connect-timeout + respawn | 85 |
| 18 | `apps/cli/cli/commands/health.ts` | `health` command | 13 |
| 19 | `apps/cli/cli/commands/project.ts` | `project create` / `project ls` commands | 30 |
| 20 | `apps/cli/cli/commands/server.ts` | `server` subcommand — **sole** composition importer; `process.exit(0)` | 32 |
| 21 | `apps/cli/cli/main.ts` | entry point; wires subcommands; imports NO server internals | 16 |

### Tests & enforcement config (review last, but they prove the above)

| File | Responsibility | LOC |
| --- | --- | --- |
| `.dependency-cruiser.cjs` | I-1 forbidden rules (two `error` rules) | — |
| `test/architecture/i1-cli-isolation.test.ts` | DO-NOT-MODIFY fitness test wrapping depcruise | 29 |
| `test/unit/connection-tracker.test.ts` | I-4 state-machine unit test (cleanest in the suite) | 39 |
| `test/integration/e2e-lifecycle.test.ts` | keystone: real WS lifecycle, I-3 + I-4 + Events stream | 99 |
| `test/integration/connect-during-shutdown.test.ts` | Bug-2 regression (stale endpoint must not hang) | 116 |
| `test/integration/find-or-spawn.test.ts` | existing-backend reuse + stale-lock recovery | 78 |
| (11 more unit/integration files) | schemas, store, projection, bus, use-cases, discovery, endpoint-file | — |

---

## 5. Subsystem walkthroughs

### 5.1 Shared contracts (the I-1-safe import surface)

These five files are the public contract both the long-lived backend and the thin CLI compile
against. Their *entire reason to exist* is **I-1**: because the CLI and backend live in the same
compiled artifact, the import graph is the only thing preventing the CLI from booting an
in-process backend. Files here are the *allowed* import targets for `apps/cli/cli/**` (alongside
`apps/cli/lib/**`), so they must stay import-pure — only `effect`, `effect/unstable/rpc`, and node
stdlib. (Verified: the complete import set across `shared/**` + `lib/**` is exactly
`effect`, `effect/unstable/rpc`, `node:os`, `node:path`, and intra-`shared` siblings. Zero server
imports today.)

- **`events.ts`** defines `ProjectCreated = Schema.TaggedStruct("ProjectCreated", {...})`; today
  `DomainEvent = ProjectCreated` (a single-member "union"). `TaggedStruct` auto-adds the
  `_tag` literal so the projection fold can `switch (_tag)`. `DomainEventFromJson =
  Schema.fromJsonString(DomainEvent)` is the JSON-text codec used at two boundaries: the SQLite
  `payload` column and the `Events` RPC stream. On **decode** it JSON-parses *and* validates, so a
  malformed/foreign-tag row fails decode rather than passing silently — the property the event
  log's integrity relies on. **Growth path** (documented in-line): swap the alias for
  `Schema.Union([...])` and add a fold case.
- **`project.ts`** is the projection *output* shape — a plain `Struct` (deliberately *not*
  tagged; it's a read-model row, not an event). Note the intentional shape difference: the event
  has `projectId`, the read-model has `id`; the projection maps one to the other.
- **`endpoint.ts`** is the **I-3 rendezvous contract**: `PROTOCOL_VERSION = 1`, the `Endpoint`
  schema (`url`, `token`, `pid`, `protocolVersion`), and `endpointFilePath()` resolving
  `$YODEA_ENDPOINT_FILE || $YODEA_HOME/server.json || ~/.yodea/server.json`. The
  `PROTOCOL_VERSION` gate makes discovery reject an incompatible future server rather than
  mis-speak to it. The env overrides are the test/runtime isolation seam (every integration test
  uses one).
- **`rpc.ts`** is the single source of truth for the protocol: a `RpcGroup` of `Health`,
  `ProjectCreate` (`payload: { name }` → `Project`), `ProjectList` (→ `Array(Project)`),
  `Connect` (`stream: true`, the I-4 presence channel), and `Events` (`stream: true`, live
  `DomainEvent` broadcast). For any `stream: true` RPC the error schema is forced to
  `Schema.Never` — by design, a SQL/codec failure is a server *defect* (`Effect.orDie`), not a
  typed RPC error.

All five files have direct unit tests, and every v4-beta API used was verified against the pinned
`4.0.0-beta.74` `.d.ts`.

### 5.2 Event-sourced core (storage + domain + application)

The whole subsystem is parameterized by the one `DomainEvent` schema.

- **`event-store.ts`** is the only durable writer/reader. One `STRICT` table
  `events(seq INTEGER PRIMARY KEY AUTOINCREMENT, stream_id, event_type, payload TEXT, created_at)`;
  `seq` is the monotonic global order — **the backbone of event sourcing**. `append` encodes the
  event to JSON *in the Effect channel* (so a codec failure is a typed `SchemaError`, not a throw)
  then INSERTs. `readAll` does `SELECT payload ... ORDER BY seq ASC` then decodes per row —
  **`ORDER BY seq ASC` is the load-bearing guarantee that replay order equals commit order.** Error
  channel is honest: `StoreError = SqlError | SchemaError`. `CREATE TABLE IF NOT EXISTS` makes boot
  idempotent across the spawn-per-command lifecycle.
- **`domain/project.ts`** is the pure, I/O-free `projectsFromEvents` fold — a left-fold over the log
  into a `Map` keyed by `projectId`, returned in insertion order. The textbook "projection =
  fold(events)" pattern; the place new event types get folded in.
- **`projections.ts`** binds the pure fold to the live log: `list = Effect.map(store.readAll,
  projectsFromEvents)`. Every `list` re-reads and re-folds the *entire* log — true projection-on-read,
  no cache.
- **`event-bus.ts`** is the in-memory live fan-out: one `PubSub.unbounded<DomainEvent>()` exposed
  three ways (`publish`, scoped `subscribe`, and `stream = Stream.fromPubSub(...)`). It is
  **live-only** — it carries no historical replay. `publish` returns `boolean` (PubSub semantics:
  `false` if shut down).
- **`use-cases.ts`** is the commit path. `createProject` mints an id + timestamp, builds the event,
  **`store.append` (the commit point — durable), then `bus.publish` (best-effort live fan-out)** —
  the ordering is the architectural statement. `listProjects` is just the projection's `list`
  (read-your-writes through the same SQLite connection). The single-connection, semaphore-serialized
  Bun SQLite driver makes that read-your-writes a genuine guarantee, not luck.

### 5.3 Server transport + lifetime

- **`connection-tracker.ts`** is the **I-4** state machine. Three pieces of state: `count`
  (`Ref<number>`), `armed` (`Ref<boolean>`), `shutdown` (`Deferred<void>`). `onConnect` increments
  count and sets `armed=true`; `onDisconnect` decrements with a `Math.max(0, c-1)` never-negative
  clamp and, **if armed and count hits 0, fires the `shutdown` Deferred once**. `armed` is the key:
  it distinguishes "0 because we just booted" from "0 because the last client left," so the server
  doesn't suicide instantly at startup. The composition root blocks on `awaitShutdown`; the
  handlers mutate the same instance (shared via the merged `coreLayer`).
- **`rpc-handlers.ts`** maps the contract to use-cases via `YodeaRpcs.toLayer({...})`.
  `ProjectCreate`/`ProjectList` call the use-case then `Effect.orDie` to discharge `SqlError |
  SchemaError` into the defect channel (matching the `Schema.Never` contract). The **`Connect`
  handler is the I-4 linchpin**: `Stream.unwrap` over `tracker.onConnect` +
  `Effect.addFinalizer(() => tracker.onDisconnect)`, then `Stream.make(true).pipe(Stream.concat(
  Stream.never))` — emit one `true` for readiness confirmation, then park forever. The finalizer
  runs when the per-request scope closes on socket drop, decrementing the count. (Verified against
  v4 internals: `RpcServer` allocates a per-request `Scope` and `Stream.unwrap`→`Channel.unwrap`
  attaches the finalizer to it, firing exactly on socket-fiber interruption.) `Events` returns
  `bus.stream` with no presence side effects.
- **`endpoint-file.ts`** is the **I-3** resource: `Effect.acquireRelease` writes `server.json` on
  acquire (via Effect `FileSystem` + `Schema.encodeEffect`, so the on-disk shape is
  contract-checked) and removes it on scope close, `Effect.ignore`d because composition deletes it
  eagerly first (the finalizer is the idempotent backup).
- **`http.ts`** is the WebSocket/NDJSON transport. Key decisions, all verified: the protocol +
  serialization are provided *into* the `rpc` layer *before* `HttpRouter.serve` (otherwise the
  `HttpRouter` requirement leaks); `serve` and the re-exported `bun` layer share one MemoMap so the
  Bun listener is built **once** (composition reads the bound port off it); `port: 0` for an
  ephemeral port; and a **499-demoting access logger** — a near-verbatim copy of
  `HttpMiddleware.logger` that logs `status === 499` (client abort from I-4 teardown interrupting
  the presence socket) at DEBUG while genuine 5xx still log at INFO.

### 5.4 Composition (`app.ts`) — the single AppLayer + lifecycle

This is the heart of **I-2** and the runtime driver of I-3/I-4. `coreLayer(dbPath)` builds the
domain/application graph as ONE memoized layer: `store` is referenced by `projection` *and*
`useCases`, and because layer memoization yields a single instance, that's **one `EventStore` (one
SQLite handle), one `EventBus`, one `ConnectionTracker`.** `EventBus` and `ConnectionTracker` are
merged at top level (not just provided into `useCases`) because the transport handlers and the
lifecycle fiber must share the *same* instances — "the count the handlers mutate is the count the
program awaits."

`runServer(options)`:
1. Builds the transport into a **dedicated child scope** (`httpScope = Scope.make()`) separate from
   the outer scope holding core — this separation is what enables on-demand, deadline-bounded
   transport teardown.
2. Reads the **real OS-assigned port** back from the Bun `HttpServer.address` (ephemeral; avoids
   EADDRINUSE during overlapping teardowns).
3. **Writes `server.json` AFTER the port is bound** (I-3) — never advertises before the socket
   accepts.
4. Blocks on `tracker.awaitShutdown` (I-4).
5. On wake: **eagerly removes `server.json`** *before* teardown (closes the back-to-back race), then
   closes `httpScope` with a **bounded ~1s `timeoutOrElse`** (the Bun graceful-stop deadlock
   workaround — the `orElse` is a successful log, so teardown continues cleanly).
6. Deliberately does **not** call `process.exit` — that lives at the CLI entry point so in-process
   tests can run `runServer` to completion.

### 5.5 CLI thin client (I-1)

The CLI is the only frontend: a thin WebSocket RPC client that owns no domain state and (with one
surgical exception) imports nothing from the server. Path aliases: `@yodea/* → apps/cli/*`.

- **`discovery.ts`** — `readEndpoint` returns `Option<Endpoint>` and **never fails**: any staleness
  signal (missing file, unreadable, malformed JSON, schema mismatch, protocol mismatch, or dead PID
  via `process.kill(pid, 0)`) yields `None`, so a stale file transparently falls through to
  spawning fresh. `spawnServer` runs `Bun.spawn([process.execPath, "server"])` then
  `child.unref()` — correct for the compiled artifact where `process.execPath` is `dist/yodea`.
  `tryAcquireLock` is the **I-2** exclusive-spawn gate: `openSync(lockPath, "wx")` (O_EXCL) stamped
  with `{pid, startedAt}`; on EEXIST it checks staleness (dead pid, garbage contents, or mtime older
  than `LOCK_STALE_AFTER_MS = 30_000`) and, if stale, deletes + retries once. `awaitEndpoint` polls
  every 50ms with a 5s budget. `findOrSpawnBackend` orchestrates: existing-live → use it; else
  acquire lock → spawn + await (with `ensuring(releaseLock)`); if lock not acquired → wait for the
  concurrent spawner.
- **`rpc-client.ts`** — `withClient(use)` per attempt: find-or-spawn → `RpcClient.make` over the
  NDJSON WebSocket protocol → **fork the `Connect()` stream for the whole scope, resolving a `ready`
  deferred on the first `true`** (this held stream IS the I-4 connection) → await `ready` bounded by
  `CONNECT_TIMEOUT = 3s` (a dying server never emits the marker → `StaleEndpoint`) → run `use` →
  scope closes → presence dropped → server may self-shut-down. Retry envelope: on `StaleEndpoint`,
  delete the endpoint file and retry find-or-spawn, up to 3 attempts; `use`'s own errors are **not**
  retried.
- **`commands/server.ts`** is the **sole I-1 exception** (whitelisted by exact path in
  dependency-cruiser, with an inline `// I-1 permitted exception` marker). It calls `runServer({
  dbPath })` wrapped in `Effect.ensuring(process.exit(0))` — placed at the entry point, not in
  `runServer`, so in-process tests aren't killed.
- **`main.ts`** wires the three subcommands and provides `BunServices.layer` (supplies
  `FileSystem | Path | ChildProcessSpawner`). It imports only `effect`, `@effect/platform-bun`, and
  the command modules — never `@yodea/composition` — preserving I-1.

### 5.6 Tests & enforcement

The enforcement design is sound. `.dependency-cruiser.cjs` has two `error` rules
(`cli-client-must-not-import-server`, `cli-composition-only-from-server-subcommand`) with
`tsPreCompilationDeps: true` so even `import type` is caught. The DO-NOT-MODIFY fitness test shells
out to `depcruise` and asserts neither rule name appears and exit code is 0 — **proven non-vacuous**
(one reviewer temporarily added a forbidden import and watched each rule fire). The
`connection-tracker.test.ts` rigorously covers the I-4 state machine. The `e2e-lifecycle.test.ts`
proves the full I-3 + I-4 lifecycle over a real WebSocket on an ephemeral port. Two regression
tests cover the connect-during-shutdown and stale-lock races. See [§8](#8-potential-issues--review-hotspots)
for the test-gate flakiness and coverage gaps.

---

## 6. Invariant enforcement map (I-1..I-4)

| Invariant | Where enforced | Mechanism | How the reviewer verifies |
| --- | --- | --- | --- |
| **I-1** CLI isolation | `.dependency-cruiser.cjs`; `test/architecture/i1-cli-isolation.test.ts`; `CODEOWNERS` | Two forbidden `error` rules (type-aware); vitest fitness test; architecture-owner review gate | `bun run arch` → 0 violations. Then **prove non-vacuity**: temporarily add `import "@yodea/server/http"` to `apps/cli/cli/commands/health.ts`, run `bun run arch` → expect `cli-client-must-not-import-server` error; revert. |
| **I-2** Single AppLayer / one backend | `apps/cli/composition/app.ts` (`coreLayer` memoization); `apps/cli/cli/discovery.ts` (`tryAcquireLock`) | One memoized layer graph → one `EventStore`/`EventBus`/`ConnectionTracker`; O_EXCL spawn lock so one spawner wins | `git grep -n "Layer.mergeAll" apps/cli/composition/app.ts` (confirm core merged once). Manual: 4-way concurrent spawn (see [§10](#10-reviewer-checklist--commands)) converges on one backend — distinct ephemeral pids resolve to one `server.json`. |
| **I-3** Single discovery file | `apps/cli/server/endpoint-file.ts` (acquireRelease); `apps/cli/composition/app.ts:~90,~108` (write-after-bind, eager-remove) | `server.json` written after the port binds, removed eagerly on shutdown + idempotent finalizer backup | Manual smoke: `ls $YODEA_HOME/server.json` exists while server runs, gone after it self-terminates. `endpoint-file.test.ts` asserts write-on-acquire / remove-on-close. |
| **I-4** Zero-connection self-shutdown | `apps/cli/server/connection-tracker.ts` (state machine); `rpc-handlers.ts` `Connect` finalizer; `app.ts` `awaitShutdown` | Arm-on-first-connect; fire `Deferred` when armed & count→0; socket drop → per-request scope close → `onDisconnect` | `bun --bun vitest run test/unit/connection-tracker.test.ts` and `test/integration/e2e-lifecycle.test.ts` (asserts server self-shuts-down after the client leaves). Manual: run one command, watch the spawned server exit shortly after. |

---

## 7. Deviations from the plan & runtime integration fixes

> The committed code under `apps/cli/` is the source of truth. The plan docs
> (`docs/superpowers/plans/2026-05-28-yodea-architectural-foundation.md` and
> `v4-migration-reference.md`) were authored against Effect 3.x and partly predate the runtime
> fixes below; they were removed from the working tree by commit `6d0583b` ("suppress superpowers",
> gitignored) but remain in git history (`git show 54b1499:docs/superpowers/plans/...`). Treat the
> plan as *intent*, not spec.

### Stack migration: Effect 3.x → Effect v4 beta `4.0.0-beta.74` (per request)

All framework code is under `effect/unstable/*` or `effect` core; only `@effect/platform-bun` +
`@effect/sql-sqlite-bun` remain separate packages. Devtools: TypeScript 6.0.3, vitest 4.1.7,
dependency-cruiser 17.4.2. Concrete v4 API corrections discovered vs the migration reference:

- `yield* SqlClient` directly — the named export IS the tag; `SqlClient.SqlClient` is `undefined`.
- Client type is `RpcClient.FromGroup<typeof YodeaRpcs, RpcClientError.RpcClientError>`.
- Service error channels widened to `SqlError | SchemaError`.
- `Effect.timeoutOrElse` (the old `timeoutFail` was removed).
- No auto-`.Default` layer — every service wires its layer explicitly via `Layer.effect`.
- **Toolchain:** tests must run via `bun --bun vitest` (the Node loader can't resolve `bun:sqlite`);
  `tsconfig` needs `ignoreDeprecations: "6.0"` (TS 6 deprecates `baseUrl`) and `skipLibCheck: true`
  is load-bearing for the effect v4 `.d.ts`.

### Runtime integration fixes (symptom → root cause → fix)

These were found by the e2e + manual testing and fixed at the right seam. Commits `15e931e`,
`90da3f2`, `1c52e45`.

1. **Bun graceful-stop grace window** (`app.ts`, commit predates the fix series; reinforced in
   `90da3f2`).
   - *Symptom:* shutdown hangs while a WebSocket is still open.
   - *Root cause:* Bun's `server.stop()` (no force flag) is graceful — it waits for every open
     socket. During I-4 teardown the presence socket is still attached, so it blocks. The
     `BunHttpServer.layer({ port })` API exposes no force-stop knob.
   - *Fix:* build the transport in a child scope and close it with a bounded `~1s timeoutOrElse`;
     the `orElse` is a successful log, so teardown proceeds and the (still-pending) `server.stop()`
     is abandoned. *(See [§8](#8-potential-issues--review-hotspots) #I3/#I4 — the abandon path is a
     bounded, intentional leak relying on the next fix.)*

2. **`process.exit(0)` on clean shutdown** (`apps/cli/cli/commands/server.ts`, `app.ts`; commit
   `15e931e`).
   - *Symptom:* each auto-spawned server hung after a clean self-shutdown — a ~100 MB zombie in
     `epoll_wait` holding the SQLite WAL open, one per command. Defeats I-4.
   - *Root cause:* the abandoned Bun handle (fix #1) keeps the event loop alive; `runMain` only
     force-exits on signal/non-zero.
   - *Fix:* `Effect.ensuring(process.exit(0))` at the CLI entry point — **not** inside `runServer`,
     so in-process e2e tests can run the server effect to completion without killing the test runner.

3. **Ephemeral port** (`app.ts`, `http.ts`; commit `90da3f2`).
   - *Symptom:* a fresh server spawned during the old one's grace window hit `EADDRINUSE` on the
     fixed port `51789`.
   - *Root cause:* fixed port + overlapping teardown windows.
   - *Fix:* bind port `0` and read the real bound port back from `HttpServer.address`, advertising
     the actual `ws://` URL. `runServer`'s `port` is now just a hint (default 0). The dead `port`
     plumbing in `SpawnOptions`/`withClient` was removed in `1c52e45`.

4. **Eager endpoint removal** (`app.ts`; commit `90da3f2`).
   - *Symptom:* a second command issued within the ~1s grace window read the stale `server.json`,
     connected to the dying server, and hung.
   - *Root cause:* `server.json` was only removed at grace-window *close*, ~1s after shutdown armed.
   - *Fix:* delete `server.json` the instant `awaitShutdown` resolves, before teardown; the
     acquireRelease finalizer stays as an idempotent backup.

5. **Client connect-timeout + respawn** (`rpc-client.ts`, `discovery.ts`; commit `90da3f2`).
   - *Symptom:* the RPC client had no connect timeout, so a connect to a dying/dead endpoint hung
     forever.
   - *Root cause:* the socket protocol's default retry policy is unbounded; nothing bounded the
     presence-readiness wait.
   - *Fix:* bound connect+presence-readiness with a 3s `timeoutOrElse` → `StaleEndpoint`; on that,
     delete the discovery file and retry find-or-spawn (up to 3 attempts) so a fresh server is
     spawned instead of hanging. Regression test: `connect-during-shutdown.test.ts`.

6. **Stale spawn-lock recovery** (`discovery.ts`; commit `1c52e45`).
   - *Symptom:* a spawner SIGKILLed *after* acquiring the lock but *before* writing `server.json`
     orphaned the `.lock` forever — every later command failed `BackendUnavailable` after the 5s
     `awaitEndpoint` timeout, needing a manual `rm *.lock`.
   - *Root cause:* the O_EXCL lock had no staleness detection (unlike `readEndpoint`'s pid check).
   - *Fix:* stamp `{pid, startedAt}` into the lock; on EEXIST treat it stale if the owner pid is
     dead/garbage or mtime > 30s, then delete + retry once. A live, recent pid is left alone (the
     legitimate concurrent-spawn case). Regression test in `find-or-spawn.test.ts`.

7. **499 log demotion** (`http.ts`; commit `1c52e45`).
   - *Symptom:* I-4 teardown interrupts the still-attached presence WebSocket, which the stock
     `HttpMiddleware.logger` rendered as `INFO ... InterruptError ... 499` — harmless but alarming.
   - *Root cause:* the interrupted socket surfaces as a client-abort 499.
   - *Fix:* a near-verbatim access logger that demotes *only* status 499 to DEBUG; 500/503 real
     failures still log at INFO with full cause, so nothing real is hidden.

---

## 8. POTENTIAL ISSUES & REVIEW HOTSPOTS

> **The most important section.** Consolidated and de-duplicated from six independent subsystem
> reviews + STATUS.md's known-limitations, prioritized. Each item: `file:line`, the concern, and
> **what to check**.

### Critical

> **There are NO confirmed Critical *correctness* bugs in production code.** The one Critical-rated
> finding was a **test/CI reliability** issue — now **fixed** (see C1).

- **[C1 — FIXED] The I-1 fitness test exceeded vitest's 5s default and failed — `test/architecture/i1-cli-isolation.test.ts`.**
  The I-1 fitness test shells out to `bunx depcruise` with `tsPreCompilationDeps: true`, which takes
  **~6.4s** (and grows with the codebase) — over vitest's 5s default. By the time the backend was
  complete this had crossed the threshold and the test failed **consistently (3/3)**, which is why
  the review machine could not reproduce the earlier "33 passed" (that green predated the codebase
  growing past the 5s line). It is a *pure timeout*, not a real I-1 violation.
  **Fix applied** (`vitest.config.ts`): `testTimeout: 30_000` + `hookTimeout: 30_000` — **config only**;
  the DO-NOT-MODIFY I-1 test and the dependency-cruiser rules are untouched, so the I-1 guarantee is
  unchanged. Re-verified **reliably green: 5/5 full-suite runs, 33/33 tests each**.
  **What to check:** re-run `bun run test` a few times and confirm consistent green; if you want the
  gate faster on CI, invoke `node_modules/.bin/depcruise` directly (avoids `bunx` cold-resolution) or
  add `options.skipAnalysisNotInRules: true` to `.dependency-cruiser.cjs`.

### Important

- **[I1] dependency-cruiser does NOT transitively protect `shared`/`lib` purity — `.dependency-cruiser.cjs:13-31`.**
  The forbidden rules only constrain edges whose `from` matches `^apps/cli/cli/`. There is **no rule**
  stopping `apps/cli/shared/**` or `apps/cli/lib/**` from importing a server module, and plain
  `to.path` matches *direct* edges only (no `reachable`/`via`). A future `shared/foo.ts` importing
  `db/...` would let the CLI transitively bundle server code — the exact I-1 failure mode — while
  `bun run arch` stays green. Latent today (all imports are pure). **What to check:** add a third
  forbidden rule `from: { path: "^apps/cli/(shared|lib)/" }, to: { path: "^apps/cli/(server|application|domain|features|infrastructure|db|services|composition)(/|$)" }`. *Highest-value hardening in the PR.*

- **[I2] Real subprocess auto-spawn path has ZERO automated coverage.** `spawnServer`
  (`discovery.ts:~39`) targets the compiled binary; under the test runner `process.execPath` is
  `bun`, not `dist/yodea`, so both race tests explicitly *cannot* exercise the real
  `Bun.spawn → boot → advertise → connect` flow and drive a hand-written `reviver` instead. A
  regression in the spawn cmd, env propagation, or `unref` would pass all tests. The "4-way
  concurrent spawn converges on one backend" claim (I-2) is **manual-only**. **What to check:**
  weigh adding a compiled-binary smoke test (`dist/yodea health --json` → `{"status":"ok"}`) and a
  multi-process spawn test to CI.

- **[I3] Lost-spawn after `awaitEndpoint` timeout fails the command even though a healthy server
  appears — `discovery.ts:~163-176`.** If *we* win the lock and spawn, then `awaitEndpoint` times
  out after 5s (slow disk / cold-start of a 101 MB binary / loaded machine), `ensuring(releaseLock)`
  frees the lock and the command fails `BackendUnavailable`. But the `unref`'d server is still
  booting and will advertise moments later. `withClient` does **not** retry `BackendUnavailable`
  (only `StaleEndpoint`). **What to check:** is 5s enough cold-spawn headroom? Consider retrying
  `BackendUnavailable` (re-read — the server is likely up a beat later).

- **[I4] Abandoned `httpScope` is a bounded, intentional leak — `app.ts:~113-119`.** When
  `Scope.close(httpScope)` times out, `program` proceeds but the close fiber is interrupted and the
  pending `server.stop()` never completes; the Bun handle stays live. Production papers over it with
  `process.exit(0)`, but the **in-process test path does not exit**, so each `runServer`-to-
  completion test may leave a live Bun server + open SQLite WAL handle. **What to check:** confirm
  vitest per-file isolation reclaims these (the abandoned `server.stop()` likely resolves once the
  test's client socket closes, after the grace window) and that there's no file-handle exhaustion or
  cross-test port/db contention under `describe.sequential`, and no detached unhandled-defect in
  test logs.

- **[I5] `app.ts` grace-window comment under-describes the platform API — `app.ts:~54-64`.** The
  comment cites only the untimed server-scope `shutdown` finalizer in `BunHttpServer.js` and asserts
  "no force-close knob." But there is **also** a 20s-bounded `preemptiveShutdown` on the serve
  scope, and `BunHttpServer.layer` *does* accept a `gracefulShutdownTimeout` option (just not a
  *force* flag). The manual scope+`timeoutOrElse` dance is still justified (20s is unacceptable for
  an interactive CLI), but a simpler `gracefulShutdownTimeout: "1 second"` may exist. **What to
  check:** verify against pinned `beta.74` whether `gracefulShutdownTimeout` propagates to the I-4
  teardown; update the comment's framing regardless.

- **[I6] `PubSub.unbounded` → memory growth under a slow/stuck subscriber — `event-bus.ts:~13`.**
  No backpressure: a stalled `Events` subscriber (slow WebSocket) buffers without bound and the
  publisher can't detect it. Near-zero risk for the single-client CLI, but the `Events` stream is
  built for future multi-frontend use. **What to check:** decide whether a bounded
  `dropping`/`sliding` PubSub is the better default before any non-CLI frontend ships (live events
  are lossy-tolerant since the log is canonical); at minimum document `unbounded` as deliberate.

- **[I7] One corrupt row poisons the entire read path — `event-store.ts:~44-46`.**
  `Effect.forEach(rows, decodeUnknownEffect(...))` short-circuits on the first un-decodable row, so a
  single malformed/forward-incompatible `payload` makes `readAll` (→ `listProjects` → every
  `ProjectList`) fail for the whole store. With schema evolution (the documented growth path), an old
  binary reading a newer log hits this. **No test** inserts a bad payload. **What to check:** decide
  whether unknown/future event tags should be *skipped* rather than fatal; add a malformed-row test
  asserting the expected `SchemaError` and that the RPC `orDie` behavior is intended.

- **[I8] No automated cross-restart durability test.** STATUS's headline is "event-sourced
  durability across zero-connection restarts," but both e2e tests create a fresh DB and never start a
  *second* server against an *existing* file; integration tests use `:memory:`. The single most
  important property of the system is **manual-only**. **What to check:** add a test: `runServer({
  dbPath})` → create project → let it shut down (I-4) → `runServer({dbPath})` again on the same file
  → assert `ProjectList` returns the prior project.

- **[I9] No concurrency / multi-client coverage.** Every integration test uses one client. The I-4
  "as long as ≥1 connection remains, the server stays alive" clause (BOUNDARIES step 4) is **never
  asserted** — only the 0→shutdown edge. The two-write `onConnect`
  (`connection-tracker.ts:~15-18`) and the non-atomic `updateAndGet`+`get(armed)` in `onDisconnect`
  are only tested single-threaded. **What to check:** add a test with two overlapping
  `withClient`/`Connect` holders proving the server survives one leaving; consider a concurrent
  connect/disconnect stress test. (Analysis shows the dangerous direction — fire-before-increment —
  *cannot* happen given the op order, but it's subtle.)

- **[I10] CODEOWNERS uses a placeholder org — `CODEOWNERS:3-5`.** Owner is the literal
  `@your-org/architecture-owners`. Until a real team is filled in, GitHub may treat the I-1 paths as
  having an unresolvable owner and silently *not* require architecture-owner approval — making the
  "relaxing I-1 needs sign-off" governance **inert**. **What to check:** substitute the real
  org/team before merge.

- **[I11] `withClient` has no global deadline; worst case ~24s — `rpc-client.ts`.** Each attempt can
  take up to ~5s (`awaitEndpoint`) + ~3s (`CONNECT_TIMEOUT`); with `MAX_ATTEMPTS=3` a pathological
  flapping server approaches ~24s before final failure. The socket protocol's default retry policy
  is **unbounded** — the design relies entirely on the 3s presence timeout + scope-close to interrupt
  it, which is correct but fragile across beta bumps. **What to check:** confirm acceptable for a
  CLI; consider one outer `timeoutOrElse` on the whole `withClient`; re-verify the unbounded-retry
  assumption on every Effect beta bump.

### Minor

- **[M1] Projection rebuild cost — `projections.ts:~17` + `event-store.ts:~42`.** Every
  `ProjectList` does a full `SELECT ... ORDER BY seq` + decode of *every* row — O(total events) per
  query, no snapshot/cache. Fine at skeleton scale; the first scaling hotspot. **Check:** confirm
  it's an accepted tradeoff and snapshots are on the roadmap.
- **[M2] `readAll` loads the whole table into memory — `event-store.ts:~40-47`.** No streaming/
  pagination; the Bun driver doesn't implement `executeStream`. Combined with M1, every list
  materializes the full history twice. Acceptable now; note it.
- **[M3] Commit-path is not transactional — `use-cases.ts:~33-35`.** `append` then `publish` are
  separate effects; an interruption between them, or a `publish` returning `false` (discarded
  boolean), commits durably but doesn't broadcast — at-most-once, lossy-by-design fan-out. Correct
  for the skeleton (next `listProjects` reads the log). **Check:** team accepts broadcast is lossy.
- **[M4] Multi-event commits won't be atomic — `event-store.ts:~33-37`.** A single INSERT is
  auto-commit-atomic today, but the "commit point" framing implies a boundary not explicitly
  expressed; a future multi-event command needs `sql.withTransaction`. **Check:** team knows not to
  add multi-event commits naively.
- **[M5] No optimistic-concurrency / idempotency on `projectId` — `event-store.ts:~30-38`.** `append`
  always INSERTs; no expected-version check. Can't collide today (fresh UUID per command) but
  standard event-store concurrency control is absent. Note for when commands target existing streams.
- **[M6] Unmanaged `Date`/`crypto` effects — `use-cases.ts:~30-31`, `lib/ids.ts:1`.** Wall-clock and
  UUID via raw globals, not Effect `Clock`/services → non-deterministic, slightly off-idiom. `ids.ts`
  relies on the global `crypto` with no `import { randomUUID } from "node:crypto"` (safe under Bun/
  Node ≥19). Cheap to live with; flag when timestamps become semantically significant.
- **[M7] Timestamps are free-form `Schema.String` — `events.ts:~6-9`, `project.ts`.** Nothing
  validates ISO-8601; `"banana"` round-trips. Reasonable for a skeleton (keeps the wire JSON-trivial);
  a contract weakness if any consumer ever sorts/compares timestamps.
- **[M8] Endpoint `url`/`token` unvalidated — `endpoint.ts:~7-12`.** `protocolVersion` is the only
  gate; a garbage-but-decodable `url` takes the slow 3s-timeout→respawn path rather than being
  rejected at decode. Self-healing, low impact for a localhost daemon.
- **[M9] `token` is dead weight today — `endpoint.ts`, `rpc-client.ts`.** Carried in the endpoint but
  never sent; no WebSocket auth. Intentionally deferred (keychain out of scope). Acknowledge it's a
  no-op.
- **[M10] `isProcessAlive` fooled by PID reuse — `discovery.ts:~10-17`.** `process.kill(pid,0)` is
  true for an unrelated recycled PID. The lock has a 30s mtime fence; `server.json` does **not** — a
  recycled-PID `server.json` is accepted and self-heals via the 3s `StaleEndpoint` retry (one wasted
  attempt). **Check:** consider a comment noting `server.json` relies on retry, not an mtime fence.
- **[M11] Lock staleness 30s window can momentarily break I-2 — `discovery.ts` (`LOCK_STALE_AFTER_MS`).**
  If a valid lock holder takes >30s from spawn to advertise, another CLI deems it stale and spawns a
  *second* server. Very unlikely (>> the 5s await window); two ephemeral-port servers don't
  EADDRINUSE — last-writer-wins on `server.json`, the orphan self-terminates via I-4. **Check:**
  confirm 30s >> realistic cold-spawn time; document it.
- **[M12] `createLockOnce` shells out to `mkdir -p` via `Bun.spawnSync` — `discovery.ts:~98`.** Heavier
  and less portable than the `node:fs` `mkdirSync({recursive})` already imported; return code ignored.
  Degrades to `BackendUnavailable` if the dir is genuinely uncreatable (rare; the server also ensures
  it).
- **[M13] `boundPort` fallback masks a real failure — `app.ts:~87`.** `addr._tag === "TcpAddress" ?
  addr.port : portHint` — the `: portHint` branch is unreachable for Bun, but if ever hit with the
  default hint `0` it advertises `ws://127.0.0.1:0/rpc` silently. **Check:** consider `Effect.die` on
  a non-`TcpAddress` address.
- **[M14] Manual `Scope.make()` not forked from the ambient scope — `app.ts:~80`.** `httpScope` is a
  fresh root scope; any failure between build (~81) and the happy-path close (~113) leaks it (no
  `server.json` is left behind, but the Bun handle leaks until process exit). Matters mainly for
  tests. **Check:** consider forking from the ambient scope or `ensuring(Scope.close)`.
- **[M15] `tsconfig.json:~19` includes a non-existent `migrations/` dir.** Harmless (tsc ignores
  missing globs) but implies a migrations system that doesn't exist (deferred). Drop or comment.
- **[M16] `find-or-spawn.test.ts:~43` comment says "(no-op) spawn" but it spawns a REAL process.**
  Under the runner `process.execPath` is `bun`, so it launches a real detached `bun server` which
  fails fast ("Script not found 'server'"). Test passes via the `reviver`, but the comment is
  misleading and the test spawns an OS process every run. **Check:** consider stubbing the spawn seam.
- **[M17] Pid `2147483647` as "guaranteed dead" — `discovery.test.ts:~39`, `find-or-spawn.test.ts:~47`.**
  Works on Linux (default `pid_max` is far below), but it's an implicit environment assumption.
- **[M18] e2e Events-stream test uses a 150ms sleep, not a handshake — `e2e-lifecycle.test.ts:~81`.**
  PubSub only delivers to live subscribers; a regression that slows subscription attachment could
  flake/false-pass under load. Acceptable; note it.
- **[M19] Integration tests `delete` `YODEA_ENDPOINT_FILE` in `afterEach` without restoring it —**
  unlike `endpoint.test.ts`'s save/restore. If a dev exports it in their shell, it's wiped for the
  rest of the process. Minor test-pollution risk.

### Worth double-checking (subtle, load-bearing, currently believed correct)

- **[W1] Single-build memoization yields ONE Bun listener — `http.ts`.** The `serve` + re-exported
  `bun` sharing one MemoMap is the only thing preventing a second listener. Verified correct via v4
  internals, but it's the assumption STATUS flags for any future composition refactor, with **no
  automated test**. Confirm the whole `transportLayer` is built in one `buildWithScope`.
- **[W2] Two separate builds share the `core` MemoMap so handlers + program see the SAME
  `ConnectionTracker` — `app.ts:~131` + `~81`.** If they didn't, there'd be two trackers and I-4
  would never fire. The e2e test is the *only* thing proving identity. **The most fragile assumption
  in the PR.** Consider an explicit identity assertion (build core once, read the tracker from both
  contexts, assert `===`).
- **[W3] Per-request scope finalizer for `Connect` actually releases on socket drop —
  `rpc-handlers.ts:~21-29`.** Verified against `RpcServer.js`/`Channel.js`, but there is **no focused
  test** that opens a `Connect` stream, drops it, and asserts count 1→0 and `awaitShutdown` fired —
  it's only transitive via e2e. Given W2's fragility, this gap is significant.
- **[W4] The `Events` stream releases its PubSub subscription on abandonment — `event-bus.ts:~19` +
  `rpc-handlers.ts:~31`.** Leak-safety depends on the RPC layer closing the consuming stream's scope.
  Confirm (ideally with a test) that abandoning an `Events` stream releases its subscription and
  doesn't accumulate orphaned subscribers across reconnects.
- **[W5] TOCTOU: a connect arriving *after* the I-4 zero-trigger is dropped — `app.ts:~100-108`.** The
  `Deferred` is one-shot and cannot "un-shut-down"; a connection in the sub-ms window between
  `awaitShutdown` firing and `fs.remove` completing is dropped. Inherent to the I-4 model (the client
  retries via connect-timeout + respawn), not a code defect — but BOUNDARIES doesn't cover
  "connect-after-zero." Acknowledge it.
- **[W6] The grace-window abandon path is never *forced* in a test — `app.ts:~25,114`.**
  `e2e-lifecycle.test.ts` asserts shutdown within 5s, which passes whether teardown took 1s (abandon)
  or longer. Consider a test holding a raw WS open through the zero-trigger asserting completion <2s,
  to actually prove the abandon path.
- **[W7] `rpc-contract.test.ts` asserts tag *existence* only.** It doesn't verify `Connect`/`Events`
  are `stream: true`, that `ProjectCreate` requires `name`, or success shapes — a drift renaming a
  payload field or flipping a stream flag would pass. A few `Rpc`-introspection assertions would lock
  the contract.
- **[W8] No negative-path test for `DomainEventFromJson`/`EndpointFromJson` decode failures.** The
  reject-on-garbage guarantee the event log + discovery rely on is only exercised indirectly. A unit
  test asserting decode throws on `"{}"`/wrong-tag would lock it.

---

## 9. Known limitations & deliberately deferred scope

> From STATUS.md. **These are NOT bugs** — they are conscious decisions within the skeleton's scope.

**Known limitations (non-blocking):**

- **~1s last-client shutdown** — the documented Bun graceful-stop grace window ([§7](#7-deviations-from-the-plan--runtime-integration-fixes) #1). If a future v4 beta exposes a force-stop, drop the window.
- **`http.ts` single-build memoization assumption** — relies on layer memoization to avoid a second listener (correct; note for any future composition refactor — see [W1](#8-potential-issues--review-hotspots)).
- **Effect v4 is beta** — modules under `unstable/`; expect breaking changes between betas; re-pin deliberately ([W3](#8-potential-issues--review-hotspots)/[I11](#8-potential-issues--review-hotspots) re-verify on each bump).

**Deliberately deferred (per plan scope — not missing work):**

- **Electron desktop** (the second frontend that motivates one-backend-many-frontends).
- **Real backend services** — Git, Terminal, FileWatcher, Highlighter, DiffParser, ACP client — and the per-project `TxQueue`.
- **ACP agent loop** — the agent invoking the `yodea` CLI as a tool.
- **OS-keychain secrets** — only env config is built today; the endpoint `token` is currently a no-op ([M9](#8-potential-issues--review-hotspots)).
- **Historical-event replay on the `Events` stream** — live-only by contract; a frontend connecting after events were committed sees nothing prior (durability is proven via the per-command spawn→list cycle, not via a catching-up subscriber).
- **Schema migrations** — schema is created inline in `event-store.ts`; no `migrations/` system ([M15](#8-potential-issues--review-hotspots)).

---

## 10. Reviewer checklist & commands

### Automated gates (run these first)

```bash
# from repo root: /home/g-imhoff/projects/yodea
bun install                          # ensure deps (pinned effect 4.0.0-beta.74 stack)

bunx tsc --noEmit                    # expect: exit 0 (strict + exactOptionalPropertyTypes + noUncheckedIndexedAccess)
bun run typecheck                    # same gate via package script

bun run test                         # expect: all green. NOTE: may flake on the I-1 test's default timeout (see C1)
bun --bun vitest run --testTimeout=30000   # rerun with a generous timeout to distinguish flake from real failure

bun run arch                         # expect: 0 dependency-cruiser violations (enforces I-1)

bun run build                        # expect: dist/yodea single binary (~101MB, 351 modules)
```

### Prove I-1 is non-vacuous (do this — it's the load-bearing guard)

```bash
# Temporarily violate I-1, confirm the guard fires, then revert:
printf '\nimport "@yodea/server/http"\n' >> apps/cli/cli/commands/health.ts
bun run arch     # EXPECT: error "cli-client-must-not-import-server"
git checkout apps/cli/cli/commands/health.ts   # revert
```

### Manual smoke (compiled binary, isolated home)

```bash
export YODEA_HOME="$(mktemp -d)"

# health (I-3 + I-4 single round-trip)
./dist/yodea health --json                     # EXPECT: {"status":"ok"}

# back-to-back durability across self-terminating servers (the back-to-back race fix)
./dist/yodea project create alpha \
  && ./dist/yodea project create beta \
  && ./dist/yodea project ls --json            # EXPECT: lists BOTH alpha and beta
#   each command spawns a distinct ephemeral-port server that self-terminates;
#   the second/third re-read the event log (durability across zero-connection restarts)

# I-3: discovery file lifecycle — run a command, observe file appears then disappears
ls "$YODEA_HOME/server.json" 2>/dev/null       # EXPECT: absent shortly after each command (I-4 reaped the server)

# Stale-lock recovery: simulate a wedged lock, confirm the CLI recovers (not BackendUnavailable)
printf '{"pid":2147483647,"startedAt":0}' > "$YODEA_HOME/server.json.lock"   # dead-pid lock, no server.json
./dist/yodea health --json                     # EXPECT: {"status":"ok"} (lock detected stale, cleared, fresh spawn)

# 4-way concurrent spawn converges on one backend
for i in 1 2 3 4; do ./dist/yodea project create "c$i" & done; wait
./dist/yodea project ls --json                 # EXPECT: all four present, one shared backend won the lock
```

### Confirm checklist

- [ ] `tsc --noEmit` exits 0.
- [ ] `bun run test` is green (and the I-1 test did not flake — re-run with `--testTimeout` if unsure; see [C1](#8-potential-issues--review-hotspots)).
- [ ] `bun run arch` reports 0 violations **and** the temporary forbidden-import experiment made it fail (non-vacuous).
- [ ] `bun run build` produces `dist/yodea`.
- [ ] Manual: `health --json` → `{"status":"ok"}`.
- [ ] Manual: back-to-back `project create` × N then `project ls` lists all (durability across restarts).
- [ ] Manual: `server.json` appears on startup, removed on shutdown (I-3); server self-terminates after the last client leaves (I-4).
- [ ] Manual: stale-lock recovery and 4-way concurrent spawn both converge cleanly.
- [ ] Reviewed [I1] (transitive `shared`/`lib` arch rule) and decided whether to require the third forbidden rule before merge.
- [ ] Reviewed [I10] CODEOWNERS placeholder — real architecture-owner team filled in before merge.
- [ ] Reviewed [W2] (shared `ConnectionTracker` identity) and [W1] (single listener) — accepted the memoization assumptions or requested an identity test.
- [ ] Confirmed the deferred scope ([§9](#9-known-limitations--deliberately-deferred-scope)) matches expectations — no deferred item is mistaken for missing required work.
