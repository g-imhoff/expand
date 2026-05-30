# PR Review Guide — `feat/electron-ink-frontends` → `develop`

> A companion for reviewing the Yodea PR, in **two parts**:
> **Part A (§1–10)** — the CLI-only architectural **foundation** (the walking skeleton on
> Effect v4 beta; the backend, unchanged by Part B).
> **Part B (§11–18)** — the **Electron + Ink frontends** built on top: the contract extracted
> to `packages/contracts`, a runtime-agnostic `packages/client-core` connection brain, a live
> `ProjectStore`, two new frontends (Ink TUI + Electron desktop), and I-1 generalized to all of them.
>
> It explains **what** to look at, in **what order**, **why** each decision was made, and —
> most importantly — **where the bodies are buried** so a reviewer can find real issues fast.
> New to this PR? Read **[§11](#11-part-b--electron--ink-frontends-what-changed)** first for the delta.

---

## Table of contents

**Part A — CLI architectural foundation**

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

**Part B — Electron + Ink frontends**

11. [Part B — what changed](#11-part-b--electron--ink-frontends-what-changed)
12. [`packages/client-core` walkthrough](#12-packagesclient-core-walkthrough)
13. [ProjectStore + the Effect→React bridge](#13-projectstore--the-effectreact-bridge-the-live-update-engine)
14. [apps/tui (Ink) walkthrough](#14-appstui-ink-terminal-frontend-walkthrough)
15. [apps/desktop (Electron) walkthrough](#15-appsdesktop-electron-desktop-frontend-walkthrough)
16. [Generalized invariants — I-1 across all frontends](#16-generalized-invariants--i-1-across-all-frontends)
17. [Bugs found & fixed during the build](#17-bugs-found--fixed-during-the-build)
18. [Frontend hotspots, verification & checklist](#18-frontend-hotspots-verification--checklist)

---

## 1. Purpose & how to use this guide

This document is a **review companion**, not a spec. Read [§2](#2-tldr) and [§3](#3-architecture-overview)
to load the mental model, then review the code in the dependency order of [§4](#4-suggested-reading-order)
using the [§5](#5-subsystem-walkthroughs) walkthroughs as a per-file map. When you want to
*find problems* (the point of a review), jump straight to **[§8 Potential Issues](#8-potential-issues--review-hotspots)** —
it is prioritized, de-duplicated, and gives `file:line` + "what to check" for every concern
surfaced across six independent subsystem reviews plus the author's own known-limitations list.

Part A is small and dense: **906 lines of production TypeScript across 21 files**, plus 724
lines of tests across 18 files; **Part B** adds the two frontends + `packages/*` (the full PR is
**85 files changed, ~4.5k insertions** vs `develop`). Every file is short. You can genuinely read
all of it. Use [§6](#6-invariant-enforcement-map-i-1i-4) to *verify* the four load-bearing
invariants yourself with copy-pasteable commands, and [§10](#10-reviewer-checklist--commands) as
the final gate — then **[§18](#18-frontend-hotspots-verification--checklist)** for the Part B gate.

The four invariants are specified normatively in [`docs/architecture/BOUNDARIES.md`](architecture/BOUNDARIES.md)
— that file is the source of truth for what the rules *mean*; this guide is about whether the
code *honors* them.

---

## 2. TL;DR

**What this PR is.** The complete walking skeleton of Yodea's architecture: a single backend
process that many frontends connect to over WebSocket RPC, built on **Effect v4 beta
(`4.0.0-beta.74`)**, with event-sourcing + CQRS at the core. **Part A** built it with one thin
CLI frontend; **Part B** adds two more — an **Ink** terminal app and an **Electron** desktop app
— all sharing one `packages/client-core` and getting **live cross-frontend updates** via the
`Events` stream. It proves every architectural seam end-to-end while deferring all real features
(no agents, no real services). Effect-first throughout (state is a `SubscriptionRef`, one
`ManagedRuntime` per app, adapters are `Layer`s).

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

- **I-1 — Frontend isolation** (generalized in Part B — see [§16](#16-generalized-invariants--i-1-across-all-frontends)). No frontend (`apps/cli/cli`, `apps/tui`, `apps/desktop`) nor `packages/client-core` may import a backend-only module; the only allowed connection to backend state is RPC, and the Electron renderer reaches it only via the preload bridge. (Sole exception: `apps/cli/cli/commands/server.ts` may import `composition/`.)
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

The enforcement design is sound. `.dependency-cruiser.cjs` has forbidden `error` rules with
`tsPreCompilationDeps: true` so even `import type` is caught. (Part B **renamed and generalized**
these from CLI-only to every frontend — now `frontends-must-not-import-backend`,
`composition-only-from-server-subcommand`, and `renderer-must-not-import-client-core`; see
[§16](#16-generalized-invariants--i-1-across-all-frontends). The old `cli-client-must-not-import-server`
name no longer exists.) The DO-NOT-MODIFY fitness test shells
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
| **I-1** Frontend isolation (generalized in Part B — see [§16](#16-generalized-invariants--i-1-across-all-frontends)) | `.dependency-cruiser.cjs`; `test/architecture/i1-cli-isolation.test.ts`; `CODEOWNERS` | **Three** forbidden `error` rules — `frontends-must-not-import-backend`, `composition-only-from-server-subcommand`, `renderer-must-not-import-client-core` (type-aware, cruising `apps packages`); vitest fitness test; architecture-owner review gate | `bun run arch` → 0 violations. Then **prove non-vacuity**: add `import "@yodea/server/http"` to `packages/client-core/with-client.ts`, run `bun run arch` → expect `frontends-must-not-import-backend`; revert. |
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
# Temporarily violate I-1, confirm the guard fires, then revert (Part B generalized this to ALL frontends):
printf '\nimport "@yodea/server/http"\n' >> packages/client-core/with-client.ts
bun run arch     # EXPECT: error "frontends-must-not-import-backend"
git checkout -- packages/client-core/with-client.ts

# And the renderer-isolation rule (Part B):
printf '\nimport "@yodea/client-core"\n' >> apps/desktop/src/renderer/use-projects.ts
bun run arch     # EXPECT: error "renderer-must-not-import-client-core"
git checkout -- apps/desktop/src/renderer/use-projects.ts
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

---

## 11. Part B — Electron + Ink frontends: what changed

> Part A (§1–10) reviewed the CLI-only **foundation**. Part B reviews everything added on
> top in commits **`0ef152c..HEAD`** (base `5855790` = end of foundation): the contract was
> extracted to a package, a runtime-agnostic **connection brain** was carved out, and **two new
> frontends** (Ink TUI, Electron desktop) were built against it. The backend did not move. Read
> §11 first to load the new mental model, then use the reading order in [§11.4](#114-suggested-reading-order-new-code).

### 11.1 The delta from the foundation

Four structural moves, no new backend behavior:

1. **The pure contract moved out of the app.** `apps/cli/shared/{rpc,events,project,endpoint}.ts`
   → `packages/contracts/` under alias `@yodea/contracts` ([`tsconfig.json:19`](../tsconfig.json)).
   The move is verbatim except the internal imports (`@yodea/shared/*` → `@yodea/contracts/*`);
   `packages/contracts/rpc.ts` only rewrites two import lines. `apps/cli/shared/` is **gone**.
   This is the I-1-safe import surface from §5.1, now a real package so non-CLI frontends can
   depend on it without reaching into `apps/cli`.

2. **A new connection brain: `packages/client-core/` (`@yodea/client-core`).** The foundation's
   `apps/cli/cli/discovery.ts` and `rpc-client.ts` (`withClient`) were **moved** here (the diffstat
   renames confirm `{apps/cli/cli => packages/client-core}/discovery.ts` and `.../with-client.ts`),
   then parameterized over a **`RuntimeAdapter`** seam so they run under Bun *or* Node/Electron. The
   CLI commands now consume it ([`apps/cli/cli/commands/health.ts:3`](../apps/cli/cli/commands/health.ts),
   [`project.ts:3`](../apps/cli/cli/commands/project.ts)) — the CLI is now just *another* client of
   client-core. New surface:
   - `adapter.ts` — the `RuntimeAdapter` interface: `protocolLayer(url): Layer<RpcClient.Protocol>`
     + `spawnBackend: Effect<void>`. The **only** cross-runtime seam ([`adapter.ts:8-14`](../packages/client-core/adapter.ts)).
   - `adapters/bun.ts` — `makeBunAdapter` + default `bunAdapter`. WebSocket via `BunSocket.layerWebSocket`;
     spawn via `Bun.spawn`. Backend command defaults from `Bun.main`, with a `backendCommand` override
     (a non-CLI frontend whose `Bun.main` is its *own* entry **must** pass it — see [`bun.ts:22-34`](../packages/client-core/adapters/bun.ts)).
   - `adapters/node.ts` — `makeNodeAdapter`. WebSocket via the `ws` npm package wired into
     `Socket.WebSocketConstructor`; spawn via `node:child_process`. `backendCommand` is **required** here.
   - `discovery.ts` — find-or-spawn, now runtime-neutral: `findOrSpawnBackend(adapter)` takes the
     adapter and calls `adapter.spawnBackend`. Switched off the Bun global to `node:fs` `mkdirSync`
     ([`discovery.ts:88`](../packages/client-core/discovery.ts), commit `b20d4af`) so it runs in the
     Electron Node main.
   - `with-client.ts` — the one-shot CLI ritual (connect → hold presence → run → drop), now
     `withClient(adapter, use)`.
   - `project-store.ts` — **new**: the long-lived live store (see [§11.2](#112-one-backend-many-frontends-now-with-live-cross-frontend-updates)).
   - `index.ts` — barrel. Deliberately re-exports the runtime-neutral core only and **does NOT
     re-export the adapters** ([`index.ts:1-7`](../packages/client-core/index.ts)) — so a Node build
     never transitively pulls `@effect/platform-bun`. Adapters are imported by explicit subpath.

3. **Two new frontends, both thin clients of client-core:**
   - `apps/tui/` — **Ink + React on Bun**. `runtime.ts` builds a `ManagedRuntime<ProjectStore>`
     from `ProjectStoreLayer(makeBunAdapter(...))`; `use-projects.ts` bridges the store's
     `SubscriptionRef` into React state; `main.tsx` renders and disposes the runtime on exit.
   - `apps/desktop/` — **electron-vite + React**, three processes: `src/main/` (Node adapter +
     `ProjectStore` + IPC), `src/preload/` (typed `contextBridge` → `window.yodea`), `src/renderer/`
     (pure React UI over `window.yodea`). Built with `electron-vite`; `dev:desktop`/`build:desktop`
     scripts ([`package.json:19-20`](../package.json)).

4. **The backend stays in `apps/cli/`.** `apps/cli/` still holds `server/`, `application/`,
   `domain/`, `db/`, `composition/` — verified unchanged in layout. No backend logic was extracted
   to a package; "many frontends" still means one daemon spawned from `apps/cli/cli/commands/server.ts`.
   The TUI and desktop adapters both spawn that same `apps/cli/cli/main.ts server` entry (or, in prod,
   the compiled `yodea` binary via `YODEA_BACKEND_CMD`).

### 11.2 "One backend, many frontends" — now with live cross-frontend updates

The foundation's diagram (§3) showed one daemon and one CLI client. The same discovery/lifetime
dance ([§5.5](#55-cli-thin-client-i-1), unchanged in `discovery.ts`/`with-client.ts`) now serves
**three** frontends, and the `Events` stream is folded into a reactive `SubscriptionRef` so a write
from one frontend appears in the others **live**:

```
   CLI (Bun)            TUI (Ink/Bun)          Desktop (Electron)
   withClient           ProjectStore           main: ProjectStore  ──IPC──►  renderer (window.yodea)
   bunAdapter           bunAdapter             nodeAdapter (ws + child_process)
       │                    │                       │
       └──────────── findOrSpawnBackend(adapter) ───┘
                    read server.json? → spawn-under-lock if absent (I-2/I-3)
                                   │
                                   ▼
                   ┌──────────── one backend daemon (apps/cli) ────────────┐
                   │ EventStore (SQLite) · EventBus PubSub · Events RPC      │
                   └───────────────────────────┬───────────────────────────┘
                                                │  Events stream (live DomainEvent fan-out)
        ┌───────────────────────────────────────┴────────────────────────────────┐
        ▼                                                                          ▼
  ProjectStore.projects : SubscriptionRef<Project[]>              (every long-lived frontend has its own)
   - open Events as a QUEUE *synchronously, in order*  ◄── before ProjectList snapshot, before any create
   - seed with ProjectList() snapshot (doubles as a barrier: subscription is live)
   - fold each future ProjectCreated into the ref  ──►  TUI re-renders / desktop pushes "project:changed"
```

Key new pieces a reviewer must understand:

- **`ProjectStore` ([`project-store.ts`](../packages/client-core/project-store.ts))** is the
  long-lived counterpart to `withClient`. Where `withClient` is one-shot (connect, do work, drop),
  the store **holds the connection for the runtime's lifetime**: presence fiber, Events-fold fiber,
  and transport are all `forkScoped`/built on the **ambient** scope ([`project-store.ts:35-40,64`](../packages/client-core/project-store.ts)),
  so they die only when the `ManagedRuntime` is disposed (which drops presence → backend may
  self-shut-down, preserving I-4).
- **The ordering is load-bearing and was a real bug fix.** The Events stream is opened **as a queue,
  synchronously in the constructing fiber, before** the `ProjectList()` snapshot
  ([`project-store.ts:53-59`](../packages/client-core/project-store.ts)). The server's `Events` is
  `Stream.fromPubSub` over an unbounded PubSub that only delivers events emitted *after* the
  subscription registers; the original lazy-fork approach let an immediate `createProject` race ahead
  of the subscribe — it happened to win over Bun's WebSocket but **lost over the Node `ws` transport**,
  leaving the ref empty. The single ordered socket makes `ProjectList`'s response a barrier proving
  the subscription is live. **Verify the comment matches the code; this is the subtlest thing in Part B.**
- **Store-construction failures are discharged as defects** via `Effect.orDie`
  ([`project-store.ts:83`](../packages/client-core/project-store.ts)) to match the plan's `never`-error
  layer signature; only the running store's `createProject` carries a typed `RpcClientError`.
- **The desktop adds one more hop.** `main/ipc.ts` forks a consumer that pushes every
  `SubscriptionRef.changes` to the renderer over `win.webContents.send("project:changed", ...)`
  ([`ipc.ts:18-22`](../apps/desktop/src/main/ipc.ts)); the renderer seeds with `listProjects()` then
  subscribes to `onProjectsChanged`. Note the renderer's own race handling: a push can beat the
  in-flight seed, so an `applied` flag lets the newer push win ([`renderer/use-projects.ts:27-53`](../apps/desktop/src/renderer/use-projects.ts)).
  The renderer wraps the IPC edge in `Effect.tryPromise` (not `Effect.promise`) so a backend-down/spawn
  failure lands in the error channel, not as a defect.

### 11.3 New repo layout (`packages/*` + `apps/*`)

```
packages/
  contracts/            @yodea/contracts        — pure wire contract (was apps/cli/shared)
    rpc.ts  events.ts  project.ts  endpoint.ts
  client-core/          @yodea/client-core      — runtime-agnostic connection brain
    adapter.ts                                  — RuntimeAdapter interface (the ONLY runtime seam)
    adapters/bun.ts                             — makeBunAdapter + bunAdapter (BunSocket, Bun.spawn)
    adapters/node.ts                            — makeNodeAdapter (ws + node:child_process)
    discovery.ts                                — find-or-spawn, runtime-neutral (node:fs, no Bun global)
    with-client.ts                              — one-shot CLI ritual
    project-store.ts                            — long-lived live store (SubscriptionRef ← Events)
    index.ts                                    — barrel; does NOT re-export adapters

apps/
  cli/                  @yodea/*                — BACKEND (unchanged) + thin CLI client
    server/ application/ domain/ db/ composition/   — backend internals (I-1 forbidden targets)
    cli/                                        — thin client; commands now import @yodea/client-core
  tui/                  @yodea/tui/*            — Ink + React (Bun)
    runtime.ts  use-projects.ts  main.tsx  components/{app,project-list,create-input}.tsx
  desktop/              @yodea/desktop/*        — electron-vite + React (alias → apps/desktop/src/*)
    src/main/{index,runtime,ipc}.ts             — Node adapter + ProjectStore + IPC wiring
    src/preload/{index.ts,api.d.ts}             — typed contextBridge → window.yodea
    src/renderer/{App.tsx,main.tsx,use-projects.ts,index.html}   — pure UI over window.yodea
    electron.vite.config.ts  package.json  tsconfig.json
```

Aliases ([`tsconfig.json:19-24`](../tsconfig.json)): `@yodea/contracts/*`, `@yodea/client-core` +
`@yodea/client-core/*`, `@yodea/tui/*`, `@yodea/desktop/*` → `apps/desktop/src/*`, and the catch-all
`@yodea/*` → `apps/cli/*`. Stack additions: separate npm `@effect/platform-node` + `ws` for the Node
adapter (commit `2b254df`); `electron` 42 + `electron-vite` 5 for desktop.

### 11.4 Suggested reading order (new code)

Same principle as [§4](#4-suggested-reading-order): contracts first, then the brain, then each
frontend, then the boundary/tests last.

| # | Path | Why read it here |
| --- | --- | --- |
| 1 | `packages/contracts/{rpc,events,project,endpoint}.ts` | The moved contract — verify it is a clean rename (only import paths changed). |
| 2 | `packages/client-core/adapter.ts` | The single runtime seam. Everything else is written against this. |
| 3 | `packages/client-core/adapters/bun.ts` · `adapters/node.ts` | The two concrete runtimes; note `backendCommand` defaulting (Bun) vs required (Node) and the Node `ws` cast. |
| 4 | `packages/client-core/discovery.ts` · `with-client.ts` | Mostly the foundation's code, now adapter-parameterized + runtime-neutral (`node:fs`). |
| 5 | `packages/client-core/project-store.ts` | **The new heart.** Read the ordering comment (`:42-58`) against the code — the Events-before-snapshot barrier. |
| 6 | `packages/client-core/index.ts` | Confirm the barrel does NOT export adapters (build-isolation guarantee). |
| 7 | `apps/tui/runtime.ts` → `use-projects.ts` → `components/*` → `main.tsx` | Simplest consumer: ManagedRuntime + Bun adapter; SubscriptionRef → React state; dispose on exit. |
| 8 | `apps/desktop/src/main/{runtime,ipc,index}.ts` | Node-adapter runtime, IPC ↔ ProjectStore, window/preload wiring + dev CDP port. |
| 9 | `apps/desktop/src/preload/{index,api.d.ts}` → `src/renderer/{use-projects,App}.tsx` | The contextBridge contract, then the pure UI; note the renderer-side seed-vs-push race + `tryPromise`. |
| 10 | `.dependency-cruiser.cjs` + `test/architecture/i1-cli-isolation.test.ts` | The generalized I-1 boundary — review last; it proves the above. See [§16](#16-generalized-invariants--i-1-across-all-frontends). |

> **Reviewer note:** the diffstat says the CLI's `discovery.ts`/`with-client.ts` were *moved*
> (renamed), not rewritten — `git log --follow` and `git diff -M 5855790..HEAD` show the rename +
> the adapter parameterization in the same commits (`29f7ddc`, `e96dbe9`). Review the diff against
> the foundation rather than re-reading the foundation logic from scratch.

## 12. `packages/client-core` walkthrough

`packages/client-core/` is the runtime-agnostic **connection brain** that was extracted so that every frontend (CLI, Ink TUI, Electron) reuses one find-or-spawn / connect / presence-channel implementation instead of re-inventing it. Alias: `@yodea/client-core`. The whole package compiles against `@yodea/contracts` (type-only at the seams) plus `effect` — it knows nothing about the backend internals it talks to (I-1). Everything runtime-specific (which WebSocket, how to spawn a process) is pushed behind **one** interface, `RuntimeAdapter`, and supplied per app.

Read it in this order: `adapter.ts` (the seam) → `adapters/bun.ts` + `adapters/node.ts` (the two implementations) → `discovery.ts` (find-or-spawn) → `with-client.ts` (the one-shot ritual) → `index.ts` (the barrel rule that keeps the two adapters from cross-contaminating a build).

### 12.1 `RuntimeAdapter` — the cross-runtime seam

`adapter.ts:8-14` is the entire seam: two members, both Effect-first so no raw side effect leaks across it.

- `protocolLayer: (url) => Layer.Layer<RpcClient.Protocol>` — a **fully-satisfied** RPC transport layer for a known backend URL (NDJSON over WebSocket). "Fully-satisfied" is the contract: the returned layer requires nothing (`RpcClient.Protocol` is the only output, no leftover `R`), so `withClient` can `Effect.provide` it blindly without knowing whether the underlying socket came from Bun's global `WebSocket` or the `ws` package.
- `spawnBackend: Effect.Effect<void>` — launch `<backend> server` detached and `unref` it. It is an `Effect`, not a function returning one, because there are no parameters: the *how* (command, child_process vs `Bun.spawn`) is closed over when the adapter is constructed.

Why it exists: `discovery.ts`, `with-client.ts`, and `project-store.ts` are written **once** against this interface (`adapter.ts:4-7` comment). Bun and Node differ in exactly two places — how you open a WebSocket and how you spawn a child — so those two places, and only those, are abstracted. Note the import is `import type` (`adapter.ts:1-2`): the seam pulls in zero runtime code.

**What to check:**
- Confirm `protocolLayer`'s return type genuinely has no residual requirement (`Layer.Layer<RpcClient.Protocol>`, not `<RpcClient.Protocol, never, SomeR>`); a leaked `R` would force every caller to provide it and defeat the abstraction.
- Confirm both members are pure values (Layer / Effect) — no eager `Bun.spawn` or socket-open at adapter-construction time.
- This file is `import type`-only; verify nothing concrete creeps in (it would become an I-1 / bundling liability since both frontends import the seam).

### 12.2 Bun adapter — `makeBunAdapter` + `bunAdapter`

`adapters/bun.ts`. Transport (`:9-13`): `RpcClient.layerProtocolSocket()` ← `RpcSerialization.layerNdjson` ← `BunSocket.layerWebSocket(url)`. `BunSocket.layerWebSocket` bundles Bun's **global** `WebSocket`, so the resulting layer requires nothing (`:7-8`) — this is what makes Bun's `protocolLayer` self-contained, in contrast to Node (§12.3).

The interesting part is the spawn command, and the **`e1b7b49` parameterization fix**:

- `makeBunAdapter(opts?)` (`:36-50`) builds `spawnBackend`: `[cmd, ...args] = opts?.backendCommand ?? defaultBackendCommand()`, then `Bun.spawn({ cmd, stdout/stderr/stdin: "ignore", env: process.env })` + `child.unref()`.
- `defaultBackendCommand()` (`:22-26`) derives the command from `Bun.main`: compiled binary → `process.execPath` *is* `yodea` → `[execPath, "server"]`; dev-from-source (entry is a `.ts/.js/...` file that exists) → `[execPath, entry, "server"]`.
- `bunAdapter = makeBunAdapter()` (`:54`) is the default export with the old behavior, so the CLI and all pre-existing imports/tests are unchanged.

**Why `Bun.main` was wrong for non-CLI frontends.** Before `e1b7b49`, `spawnBackend` always derived from `Bun.main`. `Bun.main` is the entry of the *running* process. For the CLI / compiled `yodea`, that entry *is* the backend's, so `[execPath, entry, "server"]` correctly relaunches itself with the `server` subcommand. For a non-CLI frontend like the Ink TUI, `Bun.main` is `apps/tui/main.tsx` — so the old code spawned a **second TUI** (which ignores the stray `"server"` arg) and never booted a backend, breaking the find-or-spawn (I-2) promise for a standalone frontend with no pre-existing backend. The fix: such callers MUST pass an explicit `backendCommand` (the `:19-21` / `:30-33` comments say so). `apps/tui/runtime.ts:22-35` does exactly that, resolving the real CLI entry via `import.meta.url` (independent of `Bun.main`) with a `YODEA_BACKEND_CMD` JSON-array override for packaged/prod. Regression test: `test/integration/bun-adapter-spawn.test.ts` proves the explicit-command spawn boots the backend *without* overriding `Bun.main`.

**What to check:**
- `defaultBackendCommand` is still correct only for the CLI/compiled binary — confirm no new non-CLI caller relies on the default instead of passing `backendCommand`.
- The non-null assertion `cmd!` (`:39`/`:41`) assumes a non-empty command array; a caller passing `backendCommand: []` would spawn `undefined`. No runtime guard exists — confirm acceptable or harden.
- `env: process.env` is passed through verbatim to the detached backend — confirm that is intended (the spawned server inherits e.g. `YODEA_HOME`/`YODEA_ENDPOINT_FILE`, which is exactly what test isolation and the TUI rely on).
- `Bun.main` is referenced unconditionally inside `defaultBackendCommand`; this file is Bun-only by construction (it imports `@effect/platform-bun`), so it must never be loaded under Node/Electron — see the barrel rule (§12.5).

### 12.3 Node adapter — `makeNodeAdapter`

`adapters/node.ts` mirrors the Bun adapter for the Electron main process (Node, no Bun global).

- **WebSocket constructor wiring** (`:11-21`): Node has no global `WebSocket`, so the adapter provides one from the `ws` npm package. `wsConstructor` (`:11-15`) is `Layer.succeed(Socket.WebSocketConstructor, (url, protocols) => new WS(...) as unknown as globalThis.WebSocket)` — the `ws` socket is wire-compatible with the browser `WebSocket` the Socket layer expects, and the double cast bridges the slightly-different TS types. `protocolLayer` (`:17-21`) then uses the **generic** `Socket.layerWebSocket(url)` (from `effect/unstable/socket`, not the Bun-specific `BunSocket`) and feeds it `wsConstructor`. So the only structural difference from Bun is: generic socket layer + an explicitly-provided constructor, vs. Bun's self-contained `BunSocket.layerWebSocket`.
- **Spawn** (`:30-35`): `spawn` from `node:child_process` with `{ detached: true, stdio: "ignore", env: process.env }` + `child.unref()` — the Node equivalent of `Bun.spawn(...).unref()`.
- **No default command.** `NodeAdapterOptions.backendCommand` is **required** (`:23-27`, non-optional) — there is no `Bun.main` to derive from under Node, so the Electron main must always tell the adapter exactly how to launch the backend (dev: `["bun", "<repo>/apps/cli/cli/main.ts", "server"]`; packaged: `[pathToCompiledYodea, "server"]`).

**What to check:**
- The `as unknown as globalThis.WebSocket` cast (`:14`) is the one type-safety hole — verify the `ws` instance actually satisfies the methods/events `Socket.layerWebSocket` calls (open/close/message/error, `binaryType`, `send`). A protocol-level mismatch would surface only at runtime over the wire.
- `ws` must be a real dependency of `client-core` (or hoisted) for the Node build; confirm it is declared, not just present transitively.
- Like Bun, `cmd!` (`:32`) assumes a non-empty `backendCommand`; the field is required but not validated non-empty.
- There is **no `makeNodeAdapter()` default export** equivalent to `bunAdapter` — confirm every Node consumer constructs it explicitly (intended, since a default is impossible without a derivable command).

### 12.4 `discovery.ts` — find-or-spawn (runtime-neutral)

`discovery.ts` is the shared find-or-spawn machinery, parameterized by the adapter. It is the former `apps/cli/cli/discovery.ts` moved into the package and made runtime-neutral. Same shape as the foundation reviewed in Part A §5.5: `readEndpoint` returns `Option<Endpoint>` and **never fails** (missing / unreadable / malformed / wrong protocol / dead-pid → `None`, `:22-36`); `tryAcquireLock` is the O_EXCL spawn gate with 30s-mtime stale recovery (`:60-121`); `awaitEndpoint` polls every 50ms with a 5s budget (`:129-138`); `findOrSpawnBackend(adapter)` orchestrates existing-live → use it, else acquire-lock → `adapter.spawnBackend` + await with `ensuring(releaseLock)`, else wait for the concurrent spawner (`:151-161`). The one structural change: `findOrSpawnBackend` now takes a `RuntimeAdapter` and calls `adapter.spawnBackend` (`:157`) instead of a hard-coded `Bun.spawn`.

The **`b20d4af` runtime-neutral fix** is the load-bearing change for Electron. `createLockOnce` (`:82-100`) ensures the discovery directory exists before opening the lock file. The old code did this with `Bun.spawnSync({ cmd: ["mkdir", "-p", ...] })` — a Bun global. `discovery.ts` is now **shared client-core that also runs in the Electron Node main process, where `Bun` does not exist**, so that line would throw `ReferenceError: Bun is not defined` and crash the Electron backend-spawn path. The fix replaces it with `mkdirSync(dirname(lockPath()), { recursive: true })` from `node:fs` (`:88`, import added at `:2`) — works identically under Bun and Node. The `:85-87` comment records exactly this rationale.

**What to check:**
- `git grep -n "Bun\." packages/client-core/discovery.ts` → expect **zero** hits. This file must be free of every Bun global (not just `Bun.spawnSync`) or it will crash under Node/Electron. (`process.kill`, `node:fs`, `node:path` are all runtime-neutral and fine.)
- `mkdirSync` is synchronous and called inside `Effect.sync` (`tryAcquireLock`, `:111`) — confirm that is acceptable (it is, the foundation already accepted sync fs in the lock path; Part A §8 [M12] flagged the old `mkdir -p` shell-out, which this fix also resolves: it's now lighter and portable, though the return is still implicit).
- `spawnBackend` failures: `findOrSpawnBackend` wraps `adapter.spawnBackend.pipe(Effect.andThen(awaitEndpoint), Effect.ensuring(releaseLock))` (`:157-160`). If `spawnBackend` itself fails (e.g. Node `spawn` ENOENT on a bad command), confirm the error surfaces sensibly rather than only manifesting as the 5s `awaitEndpoint` → `BackendUnavailable` timeout.
- The `import type { RuntimeAdapter }` (`:5`) is type-only — confirm discovery pulls in neither adapter implementation (it must not, or the barrel rule below is moot).

### 12.5 `with-client.ts` (one-shot ritual) + the `index.ts` barrel rule

**`with-client.ts`** is the one-shot CLI ritual, now adapter-parameterized: `withClient(adapter, use)` (`:34-77`). Per attempt: `findOrSpawnBackend(adapter)` → `RpcClient.make(YodeaRpcs)` → **`Effect.forkScoped` the `Connect()` presence stream for the whole scope, resolving a `ready` deferred on the first `true`** (`:45-49`, this held stream *is* the I-4 connection) → `Deferred.await(ready)` bounded by `CONNECT_TIMEOUT = 3s` → on timeout fail `StaleEndpoint` → run `use(client)` → scope closes (`:63` `Effect.scoped`) → presence dropped. The transport is supplied with `Effect.provide(adapter.protocolLayer(endpoint.url))` (`:63`) — the *only* place the adapter's transport is injected, and the reason `protocolLayer` must be fully-satisfied (§12.1). Retry envelope (`:70-76`): on `StaleEndpoint`, `deleteEndpoint` then retry find-or-spawn up to `MAX_ATTEMPTS = 3`; `use`'s own errors carry a different tag and are **not** retried. Logic is identical to the foundation's `rpc-client.ts` (Part A §5.5 / §7 #5) — the change is purely the `adapter` parameter threading `protocolLayer` + `spawnBackend` through.

**The `index.ts` barrel rule** (`index.ts:1-7`) is the key new packaging invariant. The barrel re-exports `RuntimeAdapter` (type), `findOrSpawnBackend`/`deleteEndpoint`/`readEndpoint`/`BackendUnavailable`, `withClient`/`YodeaClient`, and `ProjectStore` — but **deliberately does NOT re-export either adapter** (`:1-3` comment). Adapters are imported only from their own subpaths (`@yodea/client-core/adapters/bun` | `/node`). Why: `adapters/bun.ts` imports `@effect/platform-bun` and uses the `Bun` global; `adapters/node.ts` imports `ws` + `node:child_process`. If the barrel re-exported both, **a Node/Electron build importing `@yodea/client-core` would transitively pull in the Bun adapter** (and `@effect/platform-bun`), and vice-versa — a broken or bloated build. By keeping adapters off the barrel, each frontend imports exactly the one adapter it needs: `apps/tui/runtime.ts:8` does `import { makeBunAdapter } from "@yodea/client-core/adapters/bun"` while pulling everything else from the barrel; the Electron main imports `/adapters/node` instead.

**What to check:**
- `git grep -n "adapters/bun\|adapters/node" packages/client-core/index.ts` → expect **zero** hits. The barrel must never re-export an adapter. This is the only thing preventing cross-runtime bundle contamination.
- Confirm `withClient` and the rest of the barrel surface (`discovery`, `project-store`) import the adapter **type-only** (`import type { RuntimeAdapter }`), so importing the barrel pulls in neither `@effect/platform-bun` nor `ws`. A stray value import of an adapter anywhere on the barrel's transitive graph reintroduces the contamination.
- Verify each frontend imports a single adapter subpath and nothing imports *both* (`git grep -rn "client-core/adapters" apps packages`) — the TUI/CLI should reference `/adapters/bun`, the Electron main `/adapters/node`, never the other.
- `withClient`'s `Effect.provide(adapter.protocolLayer(...))` is inside `Effect.scoped` (`:63`) — confirm the transport layer's scope is the per-attempt scope so a failed/retried attempt tears its socket down before the next attempt (it is; same scope that interrupts the forked `Connect` stream).

## 13. ProjectStore + the Effect→React bridge (the live-update engine)

This is the crown jewel of Part B: the single piece of runtime-agnostic machinery that turns a
one-shot RPC client into a **long-lived, reactive store** every frontend renders from. It lives in
[`packages/client-core/project-store.ts`](../packages/client-core/project-store.ts) (89 LOC), and
both frontends consume it through a `ManagedRuntime` — directly in the TUI (Bun, in-process), and
via an IPC hop in the desktop main process (Node). Read this file slowly; the whole live-update
behavior of both UIs rests on ~50 lines, and one of those lines is load-bearing against a genuine
race (§13.2).

Contrast it with the foundation's [`with-client.ts`](../packages/client-core/with-client.ts): that
is the **one-shot CLI ritual** (connect → run `use` → tear down). `project-store.ts` is the
**daemon-shaped** counterpart — it connects once and *stays* connected for the runtime's lifetime,
folding a live event stream into reactive state.

### 13.1 Store construction — what happens, in order

`makeStore(adapter)` ([`project-store.ts:26-83`](../packages/client-core/project-store.ts#L26)) is
an `Effect.gen` that runs **on the ambient (layer/runtime) scope**, not a transient one. The order
of operations is the whole design — read it top to bottom:

1. **`findOrSpawnBackend(adapter)`** (`:32`) — reuse of the foundation's runtime-neutral
   discovery (find-or-spawn-under-lock), now driven through the `RuntimeAdapter` seam so Bun and
   Node share it. Yields a live `Endpoint`.
2. **`SubscriptionRef.make<ReadonlyArray<Project>>([])`** (`:33`) — the reactive cell. This single
   ref *is* the store's state; everything below either seeds it or appends to it, and the React
   bridge (§13.4) subscribes to its `.changes`.
3. **`Layer.build(adapter.protocolLayer(endpoint.url))`** (`:36`) — builds the NDJSON-over-WebSocket
   transport Layer **into the ambient scope** and hands back its `Context`. This is the subtle move:
   see the WHY below.
4. **`RpcClient.make(YodeaRpcs).pipe(Effect.provideContext(protocol))`** (`:37`) — constructs the
   typed client against the contract, fed the transport context from step 3.
5. **`Effect.forkScoped(Stream.runDrain(client.Connect()))`** (`:40`) — opens the **I-4 presence
   channel** and holds it for the whole scope. Dropping it (runtime dispose) is what lets the backend
   self-shut-down (§13.3).
6. **`client.Events(undefined, { asQueue: true })`** (`:53`) — opens the live event stream **as a
   queue, synchronously in this fiber**. This is the race fix; see §13.2.
7. **`client.ProjectList()` → `SubscriptionRef.set`** (`:59-60`) — the initial snapshot. Also a
   happens-before barrier (§13.2).
8. **`Effect.forkScoped(Queue.take(events) … Effect.forever)`** (`:64-75`) — the fold fiber: take
   each event, and on `ProjectCreated` append `{ id, name, createdAt }` to the ref, **deduping by
   `p.id === event.projectId`** (`:69`). Note the event→read-model field rename (`projectId` → `id`),
   the same shape difference flagged in the foundation's §5.1.

The whole gen is wrapped in **`.pipe(Effect.orDie)`** (`:83`): construction failures (backend
unreachable, snapshot RPC error) are unrecoverable *startup* defects, matching the layer's `never`
error signature. The store's *running* typed error survives on `createProject`'s
`RpcClientError` (`:13`, `:77`). `ProjectStoreLayer(adapter)` (`:87-88`) is a **parameterized
layer** — the adapter is captured in closure because the URL is only known at runtime.

**WHY `Layer.build` + the ambient scope (the non-obvious bit a reviewer should scrutinize).**
A normal frontend would make the transport a static layer dependency. It can't here, because
**`protocolLayer` needs the URL** (`adapter.protocolLayer(url)`,
[`adapter.ts:11`](../packages/client-core/adapter.ts#L11)) and the URL isn't known until
`findOrSpawnBackend` has discovered/spawned the backend at runtime. So the transport must be built
*inside* the gen, after discovery. Building it with `Layer.build` (not `Layer.provide`-ing the whole
gen) means the resulting transport — its WebSocket, its fibers — is attached to the **ambient scope**
(`Scope.Scope` is in the requirement set, `:29`), so it **outlives the gen** and lives until
`ManagedRuntime.dispose`. The same reasoning is why `Connect` and the fold use `forkScoped` (`:40`,
`:64`): a plain `fork` would die with the gen; `forkScoped` ties them to the runtime scope.
- **Check:** the requirement set is exactly `FileSystem.FileSystem | Scope.Scope` (`:29`). If a
  future edit drops `Scope.Scope`, the transport/fibers would attach to a transient scope and the
  store would go dead the instant construction returns — a silent regression no type error catches at
  the call sites (both runtimes provide a scope).

### 13.2 The subscribe-before-publish race and its fix (commit `2c3d22a`)

This is the most important correctness detail in Part B. **Before the fix**, the fold was
`Effect.forkScoped(Stream.runForEach(client.Events(), …))` — i.e. `client.Events()` was evaluated
*lazily, inside a forked fiber*. That meant the **subscribe request could be sent late**, after a
`createProject` had already round-tripped. The server's `Events` handler is `Stream.fromPubSub` over
an **unbounded PubSub** (foundation §5.2/§5.3), and PubSub **only delivers events emitted *after* a
subscription is registered**. So an immediate create published its `ProjectCreated` before the server
saw the subscribe → the event was never pushed → the ref stayed `[]`. Over **Bun's WebSocket the
fork happened to win** that race (so the bug was invisible); over the **Node `ws`** transport it lost
and exposed it. (See the inline post-mortem at `:42-52` and the commit message of `2c3d22a`.)

**The fix (two coupled lines):**

- **`const events = yield* client.Events(undefined, { asQueue: true })`** (`:53`) — opening the
  stream **as a queue, synchronously in the construction fiber**, sends the stream-open (subscribe)
  request **in socket order, before** the snapshot and **before any consumer could call
  `createProject`** (construction hasn't returned the store yet).
- **`client.ProjectList()`** (`:59`) is then a **happens-before barrier**: requests travel a single
  ordered socket, so `ProjectList`'s *response* can only arrive after the server has processed the
  *earlier* `Events` subscribe. The completed round-trip therefore **proves the subscription is
  registered server-side** before `makeStore` returns — and thus before the first possible create.

**Why this is genuinely race-free (not just "Node now happens to win too").** It does not rely on
fork timing at all. The single ordered socket gives FIFO request processing; the subscribe is
*enqueued first*; the `ProjectList` reply is a synchronous proof that the server has drained past the
subscribe. Any `ProjectCreated` published after that point is, by PubSub semantics, delivered to the
now-registered subscription. The queue's lifecycle is still bound to the ambient scope (`:52`), so it
tears down with the runtime exactly like the old fork.
- **Check the ordering is preserved:** `Events` (`:53`) **must** be evaluated before `ProjectList`
  (`:59`), and both before the store is returned (`:77`). Reordering them, or moving `Events` back
  inside a forked `runForEach`, silently reintroduces the race — and it will *pass on Bun and fail on
  Node*, so a Bun-only test run won't catch it. The regression coverage lives in
  [`test/integration/node-adapter.test.ts`](../test/integration/node-adapter.test.ts) (added in the
  same commit); confirm it actually drives a create-then-observe over the `ws` transport.
- **Note:** the snapshot-as-barrier means the store can briefly hold both the snapshot row *and* a
  pushed `ProjectCreated` for the same project — hence the dedupe-by-`id` at `:69` is **not** belt-
  and-braces, it is required.

### 13.3 I-4 presence + dispose (the live store must not pin the backend forever)

The store generalizes the foundation's I-4 contract from "one CLI command" to "a long-lived
frontend." The presence channel is `Effect.forkScoped(Stream.runDrain(client.Connect()))`
([`project-store.ts:40`](../packages/client-core/project-store.ts#L40)) — **held for the entire
runtime scope**. As long as the runtime lives, that one connection keeps the backend's
ConnectionTracker count ≥ 1, so the backend stays up (foundation I-4). Tearing the store down is
therefore the *only* thing that lets the shared daemon die.

The teardown is wired at each frontend's exit:
- **TUI:** [`apps/tui/main.tsx:11-12`](../apps/tui/main.tsx#L11) — `waitUntilExit().then(() =>
  runtime.dispose())`. Ink's exit promise resolves → dispose closes the ambient scope → interrupts
  the `Connect` drain → server sees count→0 → self-shutdown (foundation §5.3).
- **Desktop:** [`apps/desktop/src/main/index.ts:44-48`](../apps/desktop/src/main/index.ts#L44) —
  `app.on("window-all-closed", () => runtime.dispose().finally(() => … app.quit()))`. Dispose runs
  **before** `app.quit()`, and only on non-darwin does it then quit — standard macOS behavior, but
  worth noting the backend is released on the **last window close**, not on app quit.

**What a reviewer must confirm still holds:**
- The presence fiber is `forkScoped` (not `fork`) and on the **ambient** scope, so `dispose()`
  actually interrupts it. (Same dependency on `Scope.Scope` as §13.1.)
- `dispose()` is reached on *every* exit path. The TUI relies on Ink's `waitUntilExit` resolving;
  a hard `SIGKILL`/crash skips it — acceptable, because the foundation's I-4 still reaps the orphan
  when its socket drops, but the *clean* path depends on these two call sites.
- Desktop: `runtime.dispose()` is fire-and-forget inside the Electron callback; confirm the
  `.finally` is the only place `app.quit()` runs so a dispose rejection can't strand the process
  without quitting. (Dispose is typed `never`-error here, so rejection is not expected — but the
  `.finally` is the right defensive shape.)

### 13.4 The Effect→React/Ink bridge

Two frontends, two different bridging strategies — and the difference is the renderer-isolation
invariant (I-1), not an accident.

**TUI — direct, in-process** ([`apps/tui/use-projects.ts`](../apps/tui/use-projects.ts)). The Bun
runtime *is* available in the render process, so the hook drives the `SubscriptionRef` straight into
React state:
- [`:14-18`](../apps/tui/use-projects.ts#L14) — on mount, `runtime.runFork(…)` of
  `Stream.runForEach(SubscriptionRef.changes(store.projects), (ps) => Effect.sync(() =>
  setProjects(ps)))`. `SubscriptionRef.changes` **emits the current value immediately, then every
  update**, so the component paints the snapshot on first frame and re-renders on every fold.
- [`:19-21`](../apps/tui/use-projects.ts#L19) — cleanup `runtime.runFork(Fiber.interrupt(fiber))`.
  **Check:** interrupting only stops the *bridge* fiber (the per-component subscriber), not the store
  itself — correct; the store lives on the runtime, not the component.
- [`:24-25`](../apps/tui/use-projects.ts#L24) — `create` is `runtime.runFork(… s.createProject(name))`.
  Fire-and-forget: the new row appears via the **event fold**, not the create's return value — so the
  UI is consistent whether the project was created locally or by another frontend. **Check:**
  `createProject`'s `RpcClientError` is dropped here (run-fork swallows it); a failed create is
  silently a no-op in the TUI. Flag if the UI should surface it (the desktop path does — see below).
- **Runtime wiring:** [`apps/tui/runtime.ts:36-41`](../apps/tui/runtime.ts#L36) builds the
  `ManagedRuntime` from `ProjectStoreLayer(makeBunAdapter({ backendCommand: … }))`. Note the
  explicit `backendCommand` (`:22-34`): the default Bun.main-derived command would spawn a **second
  TUI**, not a backend, so this override is mandatory and correct — verify it resolves to the CLI
  entry, not the TUI's.

**Desktop — across the process boundary** (renderer must not import client-core; that's the
`renderer-must-not-import-client-core` cruiser rule + I-1). So the Effect store lives only in **main**,
and the bridge is split:
- **Main side** ([`apps/desktop/src/main/ipc.ts:13-23`](../apps/desktop/src/main/ipc.ts#L13)) —
  `registerIpc` handles `project:list`/`project:create` over IPC and **forks a push fiber**:
  `Stream.runForEach(SubscriptionRef.changes(s.projects), (ps) => … send("project:changed", ps))`.
  Same `SubscriptionRef.changes` source as the TUI, but the sink is `webContents.send` instead of
  `setState`.
- **Renderer side** ([`apps/desktop/src/renderer/use-projects.ts`](../apps/desktop/src/renderer/use-projects.ts))
  — talks **only** to `window.yodea` (the preload bridge), never to Effect. It seeds via one-shot
  `listProjects()` and subscribes to `onProjectsChanged` (`:36-53`), with an **`applied` flag so a
  push that lands before the in-flight seed wins** (`:27`, `:47`) — the renderer-side analogue of the
  §13.2 ordering concern, here solved by last-writer-wins rather than a socket barrier (there is no
  ordered socket across the IPC seam). IPC calls are wrapped in **`Effect.tryPromise` (not
  `Effect.promise`)** so a rejected `invoke` (backend down, spawn/validation failure) lands as a typed
  error the UI renders (`:9-11`, `:40-53`, `:61-80`), not an unhandled rejection. `create` resolves
  `true`/`false` so the form can decide whether to clear (`:94-96`) — a deliberately richer contract
  than the TUI's fire-and-forget.
- **Check the isolation:** `use-projects.ts` (renderer) imports only `react`, `effect` (for
  `tryPromise`), and **type-only** `@yodea/contracts/project` + `@yodea/desktop/preload/api` — no
  `client-core`. The `globalThis.yodea` indirection at `:82-85` exists purely so the module typechecks
  under the non-DOM root tsconfig; confirm it doesn't become an excuse to smuggle anything else across.

**Cross-cutting reviewer note.** Both bridges depend on `SubscriptionRef.changes` replaying the
current value to a new subscriber (TUI relies on it for first paint; the desktop **renderer** does
*not* get a replay over IPC, which is exactly why it needs the explicit `listProjects()` seed at
`:27`). If a beta bump changes `changes` to "future-only," the TUI would paint empty until the first
fold and the desktop main push fiber would miss the initial snapshot — re-verify this on every Effect
bump alongside the I-11/W3 beta-fragility items in Part A §8.

## 14. apps/tui (Ink terminal frontend) walkthrough

The TUI is the second frontend (after the CLI) and the first to exercise the new `@yodea/client-core` brain from a long-lived, *interactive* process. It is deliberately tiny — **226 LOC across 9 files** (`git diff --stat 0ef152c..HEAD -- apps/tui test/tui`) — and split cleanly into two halves: an Effect-side **runtime/bridge** (`runtime.ts`, `use-projects.ts`) that owns the connection, and **pure presentational React** (`components/*.tsx`) that knows nothing about Effect. Path alias: `@yodea/tui/* → apps/tui/*` (tsconfig.json:22; mirrored in vitest.config.ts:23). There is no `apps/tui/package.json` — it rides the repo root toolchain and runs under Bun.

### 14.1 `runtime.ts` — the ManagedRuntime + backend-path resolution

This is the only file in the TUI that touches the connection brain. It builds **one `ManagedRuntime` per app** from the long-lived store layer:

```
ProjectStoreLayer(makeBunAdapter({ backendCommand })).pipe(Layer.provide(BunServices.layer))
```

(`runtime.ts:36-41`). `ProjectStoreLayer` (packages/client-core/project-store.ts:87) builds the live store on the **ambient runtime scope** — held connection, I-4 presence fiber, and the Events-fold fiber all live until the runtime is disposed. `BunServices.layer` supplies the `FileSystem` that `findOrSpawnBackend` needs. The runtime type is `ManagedRuntime.ManagedRuntime<ProjectStore, never>` (`runtime.ts:10`) — `never` error channel because store-construction failures (backend unreachable, snapshot RPC error) are discharged as defects via `Effect.orDie` (project-store.ts:83), not surfaced as typed errors.

**The load-bearing detail is backend-command resolution** (`resolveBackendCommand`, `runtime.ts:22-34`). The default `makeBunAdapter()`/`bunAdapter` derives the spawn command from `Bun.main` (adapters/bun.ts:22-26) — correct for the CLI and the compiled `yodea` binary, where `Bun.main` *is* the backend entry. **For the TUI that default is actively wrong**: `Bun.main` is `apps/tui/main.tsx`, so the derived command would spawn a *second TUI* and never boot a backend (`runtime.ts:15-21`). So the TUI resolves the backend independently:

- **Prod/packaged:** `YODEA_BACKEND_CMD` env override — parsed as a JSON array of strings, validated (`runtime.ts:23-30`), e.g. `["/path/to/yodea","server"]`.
- **Dev:** resolve the real CLI entry **relative to this module via `import.meta.url`** — `fileURLToPath(import.meta.url)` → `.../apps/tui/runtime.ts`, then `join(here, "..", "..", "cli", "cli", "main.ts")` → `.../apps/cli/cli/main.ts`, run as `[process.execPath, backendEntry, "server"]` (`runtime.ts:31-33`). This is robust precisely *because* it does not depend on `Bun.main`.

`RuntimeContext` (`runtime.ts:13`) is a React context (`createContext<YodeaRuntime | null>(null)`) — its sole purpose is **test injection**: tests provide a fake-store runtime instead of `makeProductionRuntime()` (see 14.4). Only `makeProductionRuntime()` calls `resolveBackendCommand()` and the real adapter.

**What to check:**
- `runtime.ts:32` — confirm the two-`..` join lands on `apps/cli/cli/main.ts` (verified: `apps/tui/runtime.ts` → `..`=`apps/tui` → `..`=`apps` → `cli/cli/main.ts`). The *inline comment* on line 19 writes it as `../cli/cli/main.ts` (one `..`) — that prose is loose; the code (two `..`) is correct. Easy to "fix" the wrong one.
- `YODEA_BACKEND_CMD` validation rejects non-arrays/non-strings but does **not** check the command exists or is executable — a bad override surfaces as a spawn failure → store-construction defect. Confirm that failure path is acceptable (it crashes the TUI rather than degrading).
- The dev path resolves a `.ts` entry and runs it with `process.execPath` (Bun). Confirm no scenario runs this under Node, where `bun apps/cli/cli/main.ts` would not apply.

### 14.2 `use-projects.ts` — the React↔Effect bridge

`useProjects()` (`use-projects.ts:7-28`) is the single seam between Ink/React and the store. It reads the runtime off `RuntimeContext` and throws if absent (`use-projects.ts:8-9`). On mount it `runFork`s a fiber that drives `SubscriptionRef.changes(store.projects)` into React `useState` via `Stream.runForEach(... Effect.sync(() => setProjects(ps)))` (`use-projects.ts:14-18`); the cleanup interrupts that fiber (`use-projects.ts:19-21`). `create(name)` is fire-and-forget: `runFork(Effect.flatMap(ProjectStore, (s) => s.createProject(name)))` (`use-projects.ts:24-25`). The hook returns `{ projects, create }` — the only surface the components see.

This is the right altitude: the reactive `SubscriptionRef` lives in the store (folded from the live `Events` stream + initial snapshot, project-store.ts:53-75), and the bridge just mirrors it into React state. New projects appear because the *server* echoes the `ProjectCreated` event the store folds — not because `create` optimistically mutates.

**What to check:**
- `create` is fire-and-forget (`runFork`): a `createProject` RPC failure (typed `RpcClientError` on the store, project-store.ts:13) is **dropped** — no error toast, no logging in the fiber. For an interactive UI this means a failed create is silently invisible. Confirm that's an accepted skeleton limitation.
- The effect deps array is `[runtime]` (`use-projects.ts:22`). The runtime is created once per app (`main.tsx:5`), so the subscription fiber is set up once — correct. But any future code that recreates the runtime would re-fork; verify stable identity.
- The interrupt on unmount is itself a `runFork` (`use-projects.ts:20`) — fire-and-forget interruption. Fine for process teardown; worth noting it doesn't await the fiber actually stopping.

### 14.3 Presentational components — pure, fast-tested

The components are pure functions of props with no Effect/runtime knowledge:

- **`components/app.tsx`** — composes `useProjects()` with `<ProjectList>` + `<CreateInput>` in a `<Box flexDirection="column" gap={1}>` (app.tsx:6-13). The only component coupled to the bridge.
- **`components/project-list.tsx`** — `({ projects }) => ...` (project-list.tsx:4); renders a count header, an empty hint, or a bulleted `name`/`id` list. Pure.
- **`components/create-input.tsx`** — a deliberately hand-rolled controlled input via `useInput` (create-input.tsx:7-19), avoiding an `ink-text-input` dependency (comment line 4). On `key.return` it submits the *trimmed* value (only if non-empty) and clears; `backspace`/`delete` pop a char; printable `input` (excluding `ctrl`/`meta`) appends. Calls `onSubmit(name)` — a prop, not the runtime.

Because these take plain props, their tests (`test/tui/project-list.test.tsx`, `test/tui/create-input.test.tsx`) use `ink-testing-library`'s `render` + `lastFrame()`/`stdin.write()` with **no backend, no runtime, no fake store** — fast and deterministic. `create-input.test.tsx` notes the ink-7 timing subtlety: `useInput` attaches its stdin listener in a post-commit effect, so writes must follow a macrotask `flush()` (a `setTimeout(_,0)`) or the input is dropped before the listener exists (create-input.test.tsx:5-8).

**What to check:**
- `useInput` (create-input.tsx:7) requires **raw mode**, which requires a **TTY**. In a non-TTY environment (piped stdin, CI without a pty, some terminal multiplexers) ink throws `Raw mode is not supported`. The TUI has no fallback/guard for this. The tests dodge it because `ink-testing-library` provides a fake `stdin`. **This is the main runtime risk** — confirm the launch story (`dev:tui`) is always a real terminal, or add a non-TTY guard.
- `create-input.tsx:16` filters `key.ctrl`/`key.meta` but not all control sequences (arrows, function keys) — those arrive as `input` strings and could append junk. Low impact for a skeleton; note it.
- Trimming on submit (line 9) means a name of only whitespace is silently ignored (no feedback). Intentional but invisible.

### 14.4 `use-projects.test.tsx` — the bridge tested with a fake-store runtime

The bridge can't be tested purely (it needs a runtime), so `test/tui/use-projects.test.tsx` injects a **fake `ProjectStore`** via `RuntimeContext` — no backend spawn, no WebSocket. `fakeLayer` (use-projects.test.tsx:10-17) is `Layer.succeed(ProjectStore, { projects: ref, createProject })` over an in-memory `SubscriptionRef`; the test builds a real `ManagedRuntime.make(fakeLayer(ref))`, renders `<App>` inside `<RuntimeContext.Provider>`, then **pushes a change through the same `ref` the store exposes** and asserts the frame re-renders (`live-one`, `Projects (1)`) after a 50ms flush (use-projects.test.tsx:29-33). It disposes the runtime in `finally`. This proves the `SubscriptionRef.changes → setState` wiring end-to-end **without the connection brain** — exactly the seam `RuntimeContext` exists to enable.

**What to check:**
- The fake store uses `ReadonlyArray<any>` and `runtime as any` (use-projects.test.tsx:10,25) — the test does not type-check the store shape against `ProjectStoreShape`. A drift in `ProjectStoreShape` wouldn't fail this test. Consider typing the fake.
- The assertion relies on a fixed 50ms `setTimeout` (use-projects.test.tsx:31) to let the forked stream + React flush — a load-bearing sleep that could flake under load (same class as the e2e Events sleep noted in Part A §8 M18).
- **Coverage gap:** there is **no test of `runtime.ts`** itself — neither `resolveBackendCommand` (the `import.meta.url` path math and `YODEA_BACKEND_CMD` parsing) nor `makeProductionRuntime`. The most error-prone TUI logic (the wrong-`Bun.main` workaround) is **unexercised**. Weigh a unit test asserting `resolveBackendCommand()` resolves to `apps/cli/cli/main.ts` and that a malformed `YODEA_BACKEND_CMD` throws.

### 14.5 `main.tsx` — entry, lifecycle, and `dev:tui`

`main.tsx` (12 lines) is the composition root: create `makeProductionRuntime()` (line 5), `render(<RuntimeContext.Provider value={runtime}><App/></RuntimeContext.Provider>)` (lines 6-10), then `waitUntilExit().then(() => runtime.dispose())` (line 12). **Disposing the runtime tears down the ambient scope** — which closes the held `Connect()` presence stream (project-store.ts:40), so the backend may self-shut-down per I-4. This is the clean handoff: ink's `waitUntilExit` resolves when the user quits, and only then is the connection dropped. Launched via `dev:tui` = `bun apps/tui/main.tsx` (package.json:18).

**What to check:**
- `waitUntilExit().then(...)` (main.tsx:12) is fire-and-forget — a `dispose()` rejection is unhandled, and there's no `process.exit`. Confirm the runtime fully draining is enough for the process to exit cleanly (the held WebSocket + forked fibers should all be interrupted by `dispose`).
- If `render` throws synchronously (e.g. raw-mode-unsupported, 14.3), `runtime.dispose()` is **never reached** — the spawned backend's presence connection is dropped only when the orphaned process is reaped, not gracefully. Verify the failure path doesn't leak a connected-but-abandoned backend.
- `dev:tui` runs the TypeScript entry directly under Bun; there is no production/packaged launch wired here (that's the `YODEA_BACKEND_CMD` path, untested per 14.4).

## 15. apps/desktop (Electron desktop frontend) walkthrough

> The second frontend, and the one that *motivates* the whole one-backend-many-frontends design
> (it was the headline deferred item in Part A's [§9](#9-known-limitations--deliberately-deferred-scope)).
> It is deliberately thin: an Electron **main** process that owns a `@yodea/client-core` connection,
> a typed `contextBridge`, and a React **renderer** that is pure UI. Eight files, ~150 LOC. Read it
> in process order — `main/runtime.ts` → `main/ipc.ts` → `main/index.ts` → `preload/*` → `renderer/*`
> — because the trust boundary runs the same direction.

### 15.1 Process topology (main owns the connection, renderer is pure UI)

The Electron security model maps cleanly onto the I-1 boundary: the **main** process is the only
side that may touch `@yodea/client-core` and Node, the **renderer** is a sandboxed browser context
that may import only `window.yodea` (the preload bridge) + `@yodea/contracts` (type-only).

- `src/main/index.ts:20-29` creates the `BrowserWindow` with the hardened `webPreferences`:
  `contextIsolation: true`, `nodeIntegration: false`, and a `preload` script. This is the
  load-bearing isolation: the renderer gets no Node, no `require`, only the contextBridge surface.
- The connection brain lives entirely in main: `index.ts:17` builds the `ManagedRuntime` (one per
  app — the desktop analogue of the CLI's per-command runtime) and hands it to `registerIpc`.
- `sandbox: false` (`index.ts:27`) — **what to check:** this is *not* the default-hardened posture.
  With `sandbox: true` the preload would run in a restricted context without full Node; here it's
  disabled. The preload (`src/preload/index.ts`) only uses `electron`'s `contextBridge`/`ipcRenderer`,
  so it does not currently *need* Node, but a reviewer should confirm `sandbox: false` is a
  deliberate choice and not just inherited scaffold. With `contextIsolation` on and
  `nodeIntegration` off, the renderer is still isolated; `sandbox: false` mainly widens what the
  *preload* could do.
- Renderer isolation is enforced mechanically — see [§15.5](#155-renderer--effect-first-edge-pure-windowyodea--contracts)
  and the `renderer-must-not-import-client-core` cruiser rule ([§16](#16-generalized-invariants--i-1-across-all-frontends)).

### 15.2 `main/runtime.ts` — Node adapter + ManagedRuntime (cwd default is a hotspot)

`src/main/runtime.ts` builds the long-lived `ProjectStore` runtime from the **Node** adapter
(`ws` + `child_process`), the desktop counterpart of the CLI's Bun adapter.

- `runtime.ts:19-24`: `ManagedRuntime.make(ProjectStoreLayer(makeNodeAdapter({...})).pipe(Layer.provide(NodeServices.layer)))`.
  `NodeServices.layer` supplies `FileSystem | Path | ChildProcessSpawner` for discovery (same role
  Part A's `BunServices.layer` plays for the CLI). `YodeaRuntime` is typed
  `ManagedRuntime<ProjectStore, never>` (`runtime.ts:8`) — the store's construction errors are
  discharged as defects in `project-store.ts:83` (`Effect.orDie`), so the `never` error channel is
  honest.
- `backendCommand()` (`runtime.ts:13-17`): `YODEA_BACKEND_CMD` (a JSON array) overrides; otherwise
  the **dev default** is `["bun", resolve(process.cwd(), "../../apps/cli/cli/main.ts"), "server"]`.

> **[HOTSPOT — cwd fragility] `runtime.ts:16`.** The default backend path is resolved against
> `process.cwd()`, *not* against the module location (`import.meta.url`) the way `main/index.ts:9`
> correctly derives `here`. It only resolves correctly when cwd is exactly `apps/desktop` — which is
> true for `bun run dev:desktop` (the root script does `cd apps/desktop && electron-vite dev`,
> `package.json:19`), but breaks the moment the app is launched from any other directory, or
> packaged. The `JSON.parse` of `YODEA_BACKEND_CMD` (`runtime.ts:15`) is also unguarded — malformed
> JSON throws synchronously during `makeRuntime()` (called at module top level, `index.ts:17`),
> crashing the main process before a window exists. **What to check:** (1) should the dev default be
> anchored to `import.meta.dirname`/the repo root instead of cwd? (2) is the unvalidated
> `JSON.parse` acceptable, or should it fail into a visible error? (3) packaging story — the comment
> at `runtime.ts:11-12` says packaged builds must set `YODEA_BACKEND_CMD` to the compiled `yodea`
> binary, but nothing enforces or defaults that, so a packaged app with no env var silently tries to
> spawn `bun` against a source path that won't exist.

### 15.3 `main/ipc.ts` — dependency-injected IPC, testable under Bun

`registerIpc` is written against an injected `IpcDeps` interface (`ipc.ts:5-9`) rather than
reaching for `ipcMain`/`webContents` directly — so it can be unit-tested under Bun with fakes,
never importing `electron`.

- The seam: `{ handle, runtime, send }` (`ipc.ts:5-9`). Real Electron objects are passed in at the
  call site (`index.ts:31-35`): `handle → ipcMain.handle`, `send → win.webContents.send`.
- Two request/response handlers (`ipc.ts:14-17`): `project:list` reads the current
  `SubscriptionRef` snapshot (`SubscriptionRef.get(s.projects)`); `project:create` calls
  `s.createProject(name)`. Both go through `runtime.runPromise` — the IPC boundary is where the
  Effect program is *run*.
- The **push fiber** (`ipc.ts:18-22`): forks `Stream.runForEach(SubscriptionRef.changes(s.projects), …)`
  → `send("project:changed", ps)`. This is the live-update pump: every new fold into the store's
  ref is pushed to the renderer over the `project:changed` channel. `registerIpc` *returns* the
  fiber (`Fiber.Fiber<void>`), but **the caller discards it** (`index.ts:31`). **What to check:**
  (1) `registerIpc` is called once per `createWindow`; on macOS where the app can re-create a window
  after `window-all-closed` is suppressed, a second call would re-register the same `ipcMain.handle`
  channels (Electron throws on duplicate `handle` for the same channel) and fork a *second* push
  fiber writing to a possibly-destroyed `webContents`. Single-window today, but worth a guard.
  (2) the discarded fiber is never interrupted independently of runtime dispose — fine while there's
  one runtime for the app lifetime, but it ties the pump's lifetime to `runtime.dispose()`
  (`index.ts:45`), not the window's.

### 15.4 Preload — typed `contextBridge` (`window.yodea`)

`src/preload/index.ts` is the entire trust surface exposed to the renderer.

- `preload/index.ts:3-11`: `contextBridge.exposeInMainWorld("yodea", { listProjects, createProject,
  onProjectsChanged })`. `listProjects`/`createProject` are thin `ipcRenderer.invoke` wrappers;
  `onProjectsChanged(cb)` subscribes to the `project:changed` channel and **returns an unsubscribe
  thunk** that calls `removeListener` (`:9`) — correct teardown, and the renderer relies on it
  (`use-projects.ts:57-58`).
- The bridge values are typed `unknown` inside the preload (it can't see `@yodea/contracts` types at
  the boundary); the *typed* contract lives in `src/preload/api.d.ts`: `YodeaBridge`
  (`api.d.ts:3-7`) plus a `declare global { interface Window { yodea: YodeaBridge } }`
  (`api.d.ts:9-13`) so the renderer sees `window.yodea` fully typed against `Project` from
  `@yodea/contracts/project`. **What to check:** the `.d.ts` is a *hand-maintained* mirror of the
  runtime `exposeInMainWorld` object — there is no compile-time link between them, so a drift (rename
  a method, change a signature in one but not the other) would typecheck cleanly and only fail at
  runtime. Confirm the two stay in lockstep, or consider deriving one from the other.

### 15.5 Renderer — Effect-first edge, pure `window.yodea` + contracts

The renderer imports **only** `react`, `effect`, `@yodea/contracts` (type-only), and the preload
bridge type — never `client-core`, never `main`. Verified by the
`renderer-must-not-import-client-core` rule ([§16](#16-generalized-invariants--i-1-across-all-frontends)).

- `src/renderer/use-projects.ts` is the IPC edge, and it is deliberately **Effect-first**: every
  `window.yodea` call is wrapped in `Effect.tryPromise` (NOT `Effect.promise`) — see the comment at
  `use-projects.ts:8-11` and the call sites at `:41-44` and `:67-70`. The rationale is sound: an
  `ipcRenderer.invoke` rejection (backend down, spawn failure, a validation error in main) is an
  *expected* failure that must land in the typed error channel and surface to the UI, not become an
  unhandled rejection / silently-dead fiber.
- Seed-then-subscribe with a race guard (`use-projects.ts:27-59`): on mount it fires a one-shot
  `listProjects()` seed *and* subscribes to `onProjectsChanged`; because the main push does **not**
  replay a current value to a fresh subscriber, the seed is needed — but a push can land before the
  in-flight seed resolves, so an `applied` flag lets the newer push win and drops the stale seed
  (`:28-34`, `:47-48`). A `live` flag (`:55-58`) makes the returned cleanup idempotent against
  late-resolving promises. **What to check:** this hand-rolled ordering logic is subtle and untested
  here (no renderer test in this section's files) — confirm the `applied`/`live` interplay under
  React 18/19 StrictMode double-invoke of effects (`main.tsx:6` wraps in `<StrictMode>`, so
  `useEffect` mount/cleanup/mount fires twice in dev).
- `bridge()` reads `window.yodea` through `globalThis` (`use-projects.ts:82-85`) explicitly so the
  module typechecks under the **non-DOM root tsconfig** too; the renderer's own tsconfig still
  validates the `YodeaBridge` shape via `api.d.ts`. A reasonable dual-tsconfig accommodation, but it
  does erase the `window` typing at that one access (cast through `unknown`).
- `App.tsx` is a minimal list+form: `useProjects()` (`App.tsx:5`), a controlled input, and a submit
  that only clears the field when `create(n)` resolves truthy (`App.tsx:13`) so a failed create
  keeps the user's text and shows `error` (`App.tsx:27`). `main.tsx` is the standard
  `createRoot(...).render(<StrictMode><App/></StrictMode>)` bootstrap.

### 15.6 Build & config: the electron-vite externalization fix

`apps/desktop/electron.vite.config.ts` defines three builds (main / preload / renderer), and its
history is the most review-worthy part.

- **Externalization fix (commit `81e5357`).** The config originally overrode
  `build.rollupOptions`, which silently *dropped* electron-vite's default dependency
  externalization. The result: electron's CJS npm shim (`node_modules/electron/index.js`, which
  calls `path.join(__dirname, …)`) got **inlined into the ESM main bundle** (`out/main/index.mjs`)
  and threw at launch: `ReferenceError: __dirname is not defined in ES module scope`. The fix
  (`electron.vite.config.ts:28-35`) adds `externalizeDepsPlugin()` to main + preload **and** an
  explicit `external` list — `electron`, `effect`, `/^effect\//`, `/^@effect\//`, `ws`, and all node
  builtins. Note `package.json` has **no `dependencies` field**, so `externalizeDepsPlugin` alone
  has nothing to read (`81e5357` commit body) — the explicit list is what actually does the work.
  Main shrank from ~1.09 MB to ~8 kB.
- **`@yodea/*` are bundled, not externalized.** The three workspace aliases
  (`electron.vite.config.ts:9-13`) are tsconfig/vite **path aliases**, not npm packages — there is
  nothing on disk to `require()` at runtime — so they are intentionally left OUT of `external` and
  get inlined via `resolve.alias` (comment at `:20-23`). This is the mechanism by which `client-core`
  / `contracts` source compiles into the desktop main bundle.
- **ESM main → `import.meta.url`, not `__dirname`.** Because the main output is ESM, `index.ts:9`
  derives `here = dirname(fileURLToPath(import.meta.url))`, and the same in the vite config
  (`electron.vite.config.ts:6-7` uses `import.meta.dirname`). The preload is loaded by **`.mjs`
  path**: `index.ts:24` → `join(here, "../preload/index.mjs")`. `package.json:5` sets
  `"main": "out/main/index.mjs"`. **What to check:** the hardcoded `../preload/index.mjs` and
  `../renderer/index.html` (`index.ts:24,40`) assume the `out/{main,preload,renderer}` layout
  electron-vite produces — confirm those relative paths survive any packaging step (the commit body
  explicitly notes proper packaging — bundling/unpacking the externalized deps into the app — is
  **deferred**; today the externalized `effect`/`ws`/`@effect/platform-node` resolve by walking up
  to the repo-root `node_modules`, which only exists in dev).
- **Scripts:** `dev:desktop` = `cd apps/desktop && electron-vite dev` (`package.json:19`),
  `build:desktop` = `cd apps/desktop && electron-vite build` (`:20`), and a separate
  `typecheck:desktop` = `tsc --noEmit -p apps/desktop/tsconfig.json` (`:21`). The `cd` is why the
  cwd-relative backend default in [§15.2](#152-mainruntimets--node-adapter--managedruntime-cwd-default-is-a-hotspot)
  happens to work in dev.
- **Dev CDP port (9222) for GUI verification.** `index.ts:13-15`: when `!app.isPackaged`, the main
  process appends `--remote-debugging-port=9222` so an AI browser agent can attach over CDP to
  drive/verify the renderer. This is how `81e5357` was verified at runtime (the commit body records:
  Electron main spawns the backend → `events.db` created → renderer reachable over CDP → a
  `window.yodea.createProject('cdp-alpha')` round-trip updates the list). **What to check:** confirm
  the port is *only* opened for unpackaged dev (it is — gated on `!app.isPackaged`); a remote
  debugging port in a shipped app would be a serious local-attack surface. The `tsconfig.json:19`
  override of `exclude: []` is also worth a note: the root tsconfig excludes
  `src/main/index.ts|preload|renderer` to keep electron/DOM-only files out of the root graph (note: only main/index.ts is excluded — ipc.ts and runtime.ts deliberately stay in the root graph, which is why ipc.ts is Bun-testable), and this config
  must re-include them — confirm the root graph and the desktop graph don't disagree on those files.

## 16. Generalized invariants — I-1 across all frontends

The foundation's I-1 ("the CLI client may not import the backend") was rewritten in this PR into a property of **every** frontend, plus a new renderer-isolation clause. Three commits do the work: `f5fcba9` (the cruiser rules + the `arch` script), `736e2d6` (`BOUNDARIES.md` + the DO-NOT-MODIFY fitness test, re-proven non-vacuous), and `2b2d1b5` (exclude build output from the cruise). The normative statement lives in [`docs/architecture/BOUNDARIES.md:12-79`](architecture/BOUNDARIES.md) — read it first; this guide checks whether the code honors it.

#### 16.1 The three forbidden rules

All three are `severity: "error"` and rely on `tsPreCompilationDeps: true` ([`.dependency-cruiser.cjs:41`](../.dependency-cruiser.cjs)), so even `import type` edges are caught — load-bearing, because the renderer imports contracts type-only.

| Rule | `from` | `to` (forbidden) | Pointer |
| --- | --- | --- | --- |
| `frontends-must-not-import-backend` | `^(apps/cli/cli\|apps/tui\|apps/desktop/src\|packages/client-core)/` | `^apps/cli/(server\|application\|domain\|features\|infrastructure\|db\|services)(/\|$)` | `.dependency-cruiser.cjs:7-15` |
| `composition-only-from-server-subcommand` | same set, **minus** `apps/cli/cli/commands/server.ts` (via `pathNot`) | `^apps/cli/composition(/\|$)` | `.dependency-cruiser.cjs:16-27` |
| `renderer-must-not-import-client-core` | `^apps/desktop/src/renderer/` | `^(packages/client-core\|apps/desktop/src/main)(/\|$)` | `.dependency-cruiser.cjs:28-37` |

Note the **two-tier** isolation for desktop: the first two rules treat all of `apps/desktop/src` as "a frontend" (no backend internals); the third tightens the *renderer* specifically so it cannot reach `client-core` **or** the Electron `main` — its only legal channels are `@yodea/contracts` (type-only) and the preload `window.yodea` bridge. The `apps/cli/cli/commands/server.ts` exception is preserved unchanged (`pathNot` on rule 2). **What to check:** the `from` of rules 1–2 matches `apps/desktop/src` while rule 3 matches `apps/desktop/src/renderer/` — confirm there's no path through which a renderer file reaches the backend that escapes *all three* (e.g. renderer → contracts is allowed and intended; renderer → main is rule 3; main → backend is rule 1).

#### 16.2 Widened cruise scope (apps + packages, out/dist excluded)

- The cruise now spans **both `apps` and `packages`**: `bun run arch` is `depcruise apps packages --config .dependency-cruiser.cjs` ([`package.json:14`](../package.json)), and the fitness test invokes `["depcruise", "apps", "packages", ...]` ([`test/architecture/i1-cli-isolation.test.ts:24-28`](../test/architecture/i1-cli-isolation.test.ts)). Without `packages` in the argv, the `packages/client-core` clause of rule 1 would never be evaluated.
- `2b2d1b5` changed `exclude.path` to `(node_modules|test|(^|/)out/|(^|/)dist/)` ([`.dependency-cruiser.cjs:43`](../.dependency-cruiser.cjs)) so the compiled `dist/yodea` and `apps/desktop/out/` artifacts are not cruised. **Why it matters:** local dev has build output present and CI does not; without this the test was non-deterministic between the two. **What to check:** the `(^|/)` anchors mean both top-level `out/` and `apps/desktop/out/` are excluded — verify no real source directory is named `out`/`dist` and thus accidentally skipped.

#### 16.3 How the renderer-isolation rule works

The renderer is *pure UI*. It imports React, `@yodea/contracts/project` (type-only, [`apps/desktop/src/renderer/use-projects.ts:3`](../apps/desktop/src/renderer/use-projects.ts)), and `@yodea/desktop/preload/api` (the `YodeaBridge` type, line 4) — and reads the actual implementation off `globalThis.yodea` at runtime ([`use-projects.ts:82-85`](../apps/desktop/src/renderer/use-projects.ts)), the contextBridge surface defined in [`apps/desktop/src/preload/index.ts:3-11`](../apps/desktop/src/preload/index.ts). It never imports `client-core` or `main`, so the Node adapter, `ws`, `child_process`, and the Effect runtime stay out of the Chromium sandbox entirely. Rule 3 is what makes that physically enforced rather than a convention.

#### 16.4 The NON-VACUOUS proof — exact commands

The fitness test ([`test/architecture/i1-cli-isolation.test.ts:33-36`](../test/architecture/i1-cli-isolation.test.ts)) asserts none of the three rule names appear in output and `code === 0`. The DO-NOT-MODIFY header (lines 1-13) records the architecture-decision spec. `736e2d6` re-proved it fires for the two new edges. Re-prove it yourself:

```bash
# from repo root: /home/g-imhoff/projects/yodea

# (a) client-core -> backend trips frontends-must-not-import-backend
printf '\nimport "@yodea/server/http"\n' >> packages/client-core/discovery.ts
bun run arch     # EXPECT: error "frontends-must-not-import-backend"
git checkout packages/client-core/discovery.ts

# (b) renderer -> client-core trips renderer-must-not-import-client-core
printf '\nimport "@yodea/client-core"\n' >> apps/desktop/src/renderer/use-projects.ts
bun run arch     # EXPECT: error "renderer-must-not-import-client-core"
git checkout apps/desktop/src/renderer/use-projects.ts

# baseline: clean tree must be green
bun run arch     # EXPECT: 0 dependency violations
```

A single `bun --bun vitest run test/architecture/i1-cli-isolation.test.ts` runs the wrapped gate; it inherits the foundation's 30s `testTimeout` (the depcruise shell-out is slow — see §8 C1). **What to check:** that both temporary edits actually flip `arch` red on the *expected* rule name (not just "some violation"), and that the tree is green again after revert.

---

## 17. Bugs found & fixed during the build

Five real bugs surfaced during runtime/review of the frontends — most by the **second transport** (Node `ws`) and the **second runtime** (Electron Node main) exercising code paths the Bun CLI never hit. Each is verified against `git show`. This is the highest-signal section for a reviewer: these are the seams where the abstractions leaked.

#### 17.1 ProjectStore subscribe-before-publish race over `ws` — `2c3d22a`

- **Symptom.** A `createProject` issued immediately after the store booted did not appear in the live `SubscriptionRef`; the ref stayed `[]`. Reproduced **only** over the Node `ws` transport — the Bun WebSocket happened to win the race, so it was invisible until the Node adapter landed.
- **Root cause.** The store opened the `Events` subscription *lazily*, inside a forked `Stream.runForEach(client.Events(), …)`. The server's `Events` handler is `Stream.fromPubSub` over an **unbounded PubSub that only delivers events emitted after the subscribe is registered**. Forking the subscribe meant the subscribe request could be sent *after* an eager `createProject` had already published `ProjectCreated` server-side — so the event was never pushed to this subscriber.
- **Fix.** Open the stream as a queue **synchronously, in socket order, before the snapshot**: `const events = yield* client.Events(undefined, { asQueue: true })` ([`packages/client-core/project-store.ts:53`](../packages/client-core/project-store.ts)), then `client.ProjectList()` (lines 59-60). Because requests share one ordered socket, the `ProjectList` round-trip **acts as an ordering barrier** — its response can't arrive until the server has processed the earlier `Events` subscribe, proving the subscription is live before the store returns and thus before any consumer can call `createProject`. The fold then drains the queue (`Queue.take(events).pipe(…, Effect.forever)`, lines 64-75) on the ambient scope.
- **Double-check.** The barrier argument hinges on *strict in-order, single-socket* RPC delivery — confirm the NDJSON socket protocol preserves request order across both adapters (it does today). Both `test/integration/node-adapter.test.ts` and `test/integration/bun-adapter-spawn.test.ts` start watching `SubscriptionRef.changes` **before** the create with a 5s bounded timeout to catch a regression — verify those timeouts stay (a silent regression would manifest as a hang, not a wrong value).

#### 17.2 Bun adapter spawned the wrong entry for non-CLI frontends — `e1b7b49`

- **Symptom.** Launching the Ink TUI with no backend already running spawned a **second TUI** instead of a backend; find-or-spawn (I-2) never produced a server.
- **Root cause.** The Bun adapter derived its spawn command from `Bun.main`, which is correct only when the running process's entry *is* the backend (the CLI / compiled `yodea`). From the TUI, `Bun.main` is `apps/tui/main.tsx`, so `spawnBackend` ran the TUI again with a `"server"` arg it ignores.
- **Fix.** Parameterized the adapter: `makeBunAdapter({ backendCommand? })` ([`packages/client-core/adapters/bun.ts`](../packages/client-core/adapters/bun.ts)) — when `backendCommand` is given it spawns exactly that; otherwise the `Bun.main`-derived `defaultBackendCommand()` is kept (so the CLI and compiled binary are unchanged, and `bunAdapter = makeBunAdapter()` keeps every existing import working). The TUI now resolves the real CLI entry via `import.meta.url` independent of `Bun.main`, with a `YODEA_BACKEND_CMD` JSON-array override for packaged builds ([`apps/tui/runtime.ts`](../apps/tui/runtime.ts), `resolveBackendCommand`).
- **Double-check.** `test/integration/bun-adapter-spawn.test.ts` proves the explicit-command spawn boots a real backend **without** touching `Bun.main` (under the runner `Bun.main` is the vitest worker, so the bare `bunAdapter` would here spawn the worker as a "second TUI"). Confirm the TUI's `import.meta.url` relative path (`runtime.ts` → `../../cli/cli/main.ts`) still resolves after any directory move, and that `YODEA_BACKEND_CMD` is rejected when it isn't a JSON string array.

#### 17.3 `Bun.spawnSync` global leaked into shared client-core, crashing the Electron Node main — `b20d4af`

- **Symptom.** The Electron Node main process crashed at runtime inside discovery.
- **Root cause.** `createLockOnce` in the (now shared) `packages/client-core/discovery.ts` called `Bun.spawnSync({ cmd: ["mkdir", "-p", …] })` to ensure the lock dir. `discovery.ts` is runtime-neutral client-core and runs in the **Electron Node main**, where the `Bun` global does not exist.
- **Fix.** Replaced it with `mkdirSync(dirname(lockPath()), { recursive: true })` from `node:fs` (already the runtime-neutral import surface) — see the diff against [`packages/client-core/discovery.ts`](../packages/client-core/discovery.ts) (`closeSync, mkdirSync, openSync, …` import). This also resolves foundation hotspot M12 (the `mkdir -p` shell-out was heavier and ignored its return code).
- **Double-check.** Grep the whole `packages/client-core/**` tree for any other `Bun.` reference — the *only* Bun-specific module is `adapters/bun.ts`, which is loaded behind an explicit subpath and never pulled into a Node build (confirmed by [`packages/client-core/index.ts:1-3`](../packages/client-core/index.ts), which deliberately does not re-export adapters). A stray `Bun.*` anywhere reachable from `discovery`/`with-client`/`project-store` would reintroduce this crash on Node/Electron.

#### 17.4 `__dirname` undefined in the ESM Electron main — `81e5357`

- **Symptom.** `ReferenceError: __dirname is not defined in ES module scope` at Electron launch.
- **Root cause.** electron-vite builds the main process as ESM (`out/main/index.mjs`); the CJS global `__dirname` is undefined there. The main used `join(__dirname, "../preload/index.mjs")` and `join(__dirname, "../renderer/index.html")`.
- **Fix.** Derive the dir from `import.meta.url`: `const here = dirname(fileURLToPath(import.meta.url))` ([`apps/desktop/src/main/index.ts:9`](../apps/desktop/src/main/index.ts)), used at lines 24 and 40. (This is *also* one of the two failure modes of 17.5 — the bundled electron CJS shim's own `__dirname` — fixed by externalizing it.)
- **Double-check.** Any other absolute-path resolution in the main/preload bundles must use `import.meta.url`, never `__dirname`/`__filename`. The preload is loaded by **path** (`join(here, "../preload/index.mjs")`) relative to the built main, so confirm the electron-vite output layout (`out/{main,preload,renderer}`) matches those `../` hops.

#### 17.5 electron-vite bundled the electron npm shim instead of externalizing it — `81e5357`

- **Symptom.** Main bundle was ~1.09 MB and threw at launch — the bundled `node_modules/electron/index.js` (a CJS shim that calls `path.join(__dirname, "path.txt")`) was inlined into the ESM `out/main/index.mjs`.
- **Root cause.** `electron.vite.config.ts` had overridden `build.rollupOptions`, which **dropped electron-vite's default dependency externalization**, so `electron` (and other npm deps) got bundled. `apps/desktop/package.json` has no `dependencies` field, so `externalizeDepsPlugin()` alone had nothing to read.
- **Fix.** Added `externalizeDepsPlugin()` to the main + preload builds **and** an explicit `build.rollupOptions.external` covering `electron`, `effect` (+ `/^effect\//`), `/^@effect\//`, `ws`, and all node builtins ([`apps/desktop/electron.vite.config.ts`](../apps/desktop/electron.vite.config.ts)). The `@yodea/*` aliases stay `resolve.alias`-only (they are tsconfig/vite path aliases, not npm packages) so they are intentionally **inlined**, not externalized. Main bundle shrank ~1.09 MB → ~8 kB.
- **Double-check.** This is a **dev-only** fix: the externalized deps are resolved from the **repo-root `node_modules`** at runtime via Node walk-up from `apps/desktop/out/main` — which exists in dev but **not** in a packaged app. Proper packaging is deferred (see §18a). Confirm the `external` list stays in sync with what the main actually imports (`effect`, `@effect/platform-node`, `ws`) — a new npm dep in the main that's *missing* from the list would silently re-bundle and could reintroduce a `__dirname`/native-loader crash.

---

## 18. Frontend hotspots, verification & checklist

#### 18a. POTENTIAL ISSUES / non-blocking follow-ups

Mirrors §8: `file:line`, the concern, what to check. None are confirmed correctness bugs in the frontend production path; they are fragilities and coverage gaps.

- **[B1] Electron `backendCommand` is cwd-fragile — `apps/desktop/src/main/runtime.ts:13-17`.** The dev default is `["bun", resolve(process.cwd(), "../../apps/cli/cli/main.ts"), "server"]`. It resolves the backend entry relative to `process.cwd()` with a hard-coded `../../`, which is only correct when the process is launched from `apps/desktop` (i.e. via `dev:desktop`, which `cd`s there — [`package.json:19`](../package.json)). Launched from any other cwd, the spawn points at a non-existent path and the store construction dies (discharged as a defect via `Effect.orDie` in `project-store.ts:83`). Contrast the TUI's `import.meta.url`-relative resolution (17.2), which is cwd-independent. **What to check:** prefer `import.meta.url`-relative resolution here too (or document that `YODEA_BACKEND_CMD` must be set for any non-`dev:desktop` launch); confirm packaging will set `YODEA_BACKEND_CMD` to the compiled `yodea`.

- **[B2] Electron main + preload have NO automated coverage — verified manually via CDP only.** The two desktop tests are unit-level: `test/desktop/ipc.test.ts` exercises `registerIpc` against a **fake** `ProjectStore` (no Electron, no real runtime), and `test/desktop/use-projects.test.ts` drives the renderer hook against a **stub** `window.yodea`. Neither boots `apps/desktop/src/main/index.ts`, the real Node adapter, the preload bridge, or a real Electron window. The actual main↔preload↔renderer↔backend path was validated **manually over CDP** (see §18b) and automated E2E was deferred. **What to check:** weigh a smoke E2E (launch the built app, attach CDP, assert a `window.yodea.createProject` round-trip updates the list) before desktop ships beyond a skeleton; today a regression in `index.ts` wiring, the externalization config (17.5), or the preload path (17.4) would pass `bun run test`.

- **[B3] macOS window lifecycle gap — `apps/desktop/src/main/index.ts:44-48`.** `window-all-closed` disposes the runtime and quits only when `process.platform !== "darwin"`; on macOS the app stays running with no window. But there is **no `app.on("activate")` handler** to re-create a window (the standard macOS pattern), and `makeRuntime()` is called **once at module load** (line 17) — so even if a window were re-created, the disposed runtime would not be rebuilt. On macOS, closing the last window leaves a headless, runtime-disposed app with no way back to a window. **What to check:** add an `activate` handler that re-creates the window (and re-establishes a runtime), or quit on macOS too for the skeleton; confirm the intended macOS behavior is a deliberate choice, not an oversight.

- **[B4] `ws`-transport eventual-consistency is asserted via timeouts, not handshakes — `test/integration/node-adapter.test.ts:34-44`, `test/integration/bun-adapter-spawn.test.ts:34-45`.** Both tests watch `SubscriptionRef.changes` with `Effect.timeout("5 seconds")` and rely on the live `Events` fold delivering the pushed `ProjectCreated`. This is correct (and is the regression guard for 17.1), but it's a **timing-bounded** assertion: under a loaded CI box a genuine slowdown could flake, and a subtle re-ordering regression manifests as a hang-to-timeout rather than a crisp failure. Same family as foundation M18. **What to check:** confirm 5s is comfortable headroom for a cold backend spawn + connect + round-trip on CI; consider whether the barrier (17.1) can be asserted more directly.

#### 18b. Verification commands (frontends)

```bash
# from repo root: /home/g-imhoff/projects/yodea
bunx tsc --noEmit            # root typecheck (CLI/TUI/client-core/contracts) — exit 0
bun run typecheck:desktop    # apps/desktop tsconfig (DOM lib for renderer, Node/Electron for main) — exit 0
bun run test                 # bun --bun vitest run — all green (incl. node-adapter, bun-adapter-spawn, test/desktop/*, test/tui/*)
bun run arch                 # 0 violations across `apps packages` (generalized I-1 — see §16)
bun run build                # dist/yodea single binary (CLI + spawnable backend)
bun run build:desktop        # electron-vite build -> apps/desktop/out/{main,preload,renderer}

# manual / interactive
bun run dev:tui              # Ink TUI from source (bun apps/tui/main.tsx); find-or-spawns the backend
bun run dev:desktop          # electron-vite dev in apps/desktop (cd's there — see B1)
```

**GUI driven over CDP.** The built Electron app was validated by driving its Chromium devtools over CDP at `localhost:9222` — the main exposes `--remote-debugging-port=9222` in dev (`!app.isPackaged`, [`apps/desktop/src/main/index.ts:13-15`](../apps/desktop/src/main/index.ts)). The check: launch the built app → main spawns the backend (`events.db` created) → attach CDP → renderer renders the Projects view → `window.yodea.createProject('cdp-alpha')` round-trips and the **live list updates** (proving main↔preload↔renderer↔backend over the Node `ws` transport end-to-end). This is the only coverage of the real Electron path today (see B2).

#### 18c. Reviewer checklist — Part B

- [ ] `bunx tsc --noEmit` **and** `bun run typecheck:desktop` both exit 0 (desktop is a separate tsconfig and is *not* covered by the root typecheck).
- [ ] `bun run test` green, including the two transport tests (`node-adapter`, `bun-adapter-spawn`) and `test/desktop/*` + `test/tui/*`.
- [ ] `bun run arch` reports 0 violations **and** the §16.4 non-vacuity experiments fired (`frontends-must-not-import-backend` from a client-core→backend edge; `renderer-must-not-import-client-core` from a renderer→client-core edge).
- [ ] `bun run build` (dist/yodea) and `bun run build:desktop` (apps/desktop/out/{main,preload,renderer}) both succeed.
- [ ] Manual: `dev:tui` find-or-spawns a backend and lists/creates projects; the spawn is the **backend**, not a second TUI (17.2).
- [ ] Manual: `dev:desktop` (or the built app over CDP at :9222) renders the Projects view and a `createProject` updates the live list (17.1/17.5).
- [ ] Reviewed [B1] (Electron `backendCommand` cwd fragility) — accepted the `dev:desktop`-only assumption or required `import.meta.url`-relative resolution / a `YODEA_BACKEND_CMD` doc.
- [ ] Reviewed [B2] (no automated Electron main/preload coverage; manual-CDP only) — accepted the deferred E2E or requested a smoke test.
- [ ] Reviewed [B3] (macOS window lifecycle: no `activate` re-create, runtime built once at load) — confirmed the intended macOS behavior.
- [ ] Confirmed no `Bun.*` global is reachable from runtime-neutral `packages/client-core/**` (only `adapters/bun.ts`, which is not re-exported from `index.ts`) — 17.3 stays fixed.
- [ ] Confirmed the electron-vite `external` list (17.5) covers everything the main imports; understood it is a **dev-only** node_modules-walk-up resolution and proper packaging is deferred (§18a, STATUS deferred scope).
