# Yodea — Architecture Walkthrough

> **What this is.** A self-contained tour of the architecture delivered on
> `feat/architectural-foundation`, written so a senior reviewer can understand
> the whole design — and *why each choice was made* — before reading a line of
> code. You should not need any other file to follow it.
>
> **What this branch is.** The complete **walking skeleton** of Yodea: one
> backend process that many frontends talk to over WebSocket RPC, built on
> **Effect v4 beta**, event-sourced at the core. It proves every architectural
> seam end-to-end against one tiny feature (create + list "projects") and
> **defers all real product features**. ~85 files, ~5,300 insertions over
> `develop`.
>
> **As-built vs. plans.** This document describes only what is *implemented in
> this branch*. The dated specs under `docs/superpowers/specs/2026-06-01-*` and
> `…/research/2026-06-01-*` are **next-iteration plans** (a chat-first TUI, a
> MessagePort/TanStack Electron redesign, an agent-first CLI output contract) —
> they appear here only as rationale and in §10, never as built.
>
> **Where to go deeper.** [`docs/architecture/BOUNDARIES.md`](architecture/BOUNDARIES.md)
> is the normative spec of the four invariants. [`docs/PR-REVIEW-GUIDE.md`](PR-REVIEW-GUIDE.md)
> is the ~1,670-line "where the bodies are buried" companion (review hotspots,
> file-by-file). [`STATUS.md`](../STATUS.md) is the build log. The C4 model and
> diagrams live in [`docs/architecture/`](architecture/).

---

## Contents

1. [The one idea](#1-the-one-idea)
2. [What's in this branch](#2-whats-in-this-branch)
3. [Concepts you need (glossary)](#3-concepts-you-need-glossary)
4. [The map — three layers](#4-the-map--three-layers)
5. [How it works, end to end](#5-how-it-works-end-to-end)
6. [The four invariants (I-1..I-4)](#6-the-four-invariants-i-1i-4)
7. [Decisions & rationale](#7-decisions--rationale)
8. [Code → docs index](#8-code--docs-index)
9. [Build, test & review in 30 minutes](#9-build-test--review-in-30-minutes)
10. [Scope — deferred & forward-looking](#10-scope--deferred--forward-looking)

---

## 1. The one idea

**One backend, many frontends.** There is exactly one backend process per user
machine. It owns the event log, the in-memory event bus, and (eventually) the
agent subprocesses. Every UI — the CLI, the Ink terminal app, the Electron
desktop app — is a thin client that **talks to** that backend over WebSocket
RPC. None of them *becomes* the backend.

```
   CLI (Bun)        TUI (Ink/Bun)        Desktop (Electron/Node)
       │                  │                       │
       └──────────── one WebSocket RPC contract (YodeaRpcs) ───────┐
                          discover-or-spawn via server.json        │
                                        ▼                          │
                       ┌──────── one backend daemon ───────┐       │
                       │  SQLite event log (source of truth)│       │
                       │  EventBus (PubSub) · projections   │◄──────┘
                       │  self-shuts-down at 0 connections  │
                       └────────────────────────────────────┘
```

This avoids the two failure modes a naïve design would hit:

- **Data divergence.** If each CLI call (or each app) booted its *own* in-process
  backend, each would write its own SQLite and run its own event bus — and the
  desktop UI would never see what the CLI did. The design makes that
  *physically impossible* (invariants **I-1**/**I-2**).
- **Cold-start cost & zombies.** Booting Effect + opening SQLite on every command
  is wasteful, and a daemon that never dies leaks resources. So the backend is
  **spawned on demand**, shared while needed, and **reaped the instant the last
  client disconnects** (invariants **I-3**/**I-4**).

Everything else in this branch is the machinery that makes that one idea hold.

---

## 2. What's in this branch

**Scope — one vertical slice, fully wired:**

| | |
|---|---|
| Domain events | **1** — `ProjectCreated` |
| Read-models | **1** — `Project` |
| RPC procedures | **5** — `Health`, `ProjectCreate`, `ProjectList`, `Connect` (stream), `Events` (stream) |
| Frontends | **3** — CLI (`apps/cli`), Ink TUI (`apps/tui`), Electron desktop (`apps/desktop`) |
| Enforced invariants | **4** — I-1..I-4 (I-1 mechanically, via `dependency-cruiser` + a fitness test) |

Everything beyond that one slice is **structural scaffolding designed to flex
as features are added** — not missing work. The deferred list (real backend
services, the agent loop, packaging, …) is in [§10](#10-scope--deferred--forward-looking).

**Pinned stack.** The Effect stack and core devtools are **exact-pinned** (Effect
v4 is beta): `effect@4.0.0-beta.74` (+ `@effect/platform-bun`,
`@effect/platform-node`, `@effect/sql-sqlite-bun`, all the same beta) ·
TypeScript 6.0.3 · Vitest 4.1.7 · dependency-cruiser 17.4.2. The frontend libs
are major-version specifiers — Ink 7, React 19, Electron 42, electron-vite 5 (a
couple of dev deps carry carets). Runtime is **Bun**; the CLI/backend compiles
to a single `dist/yodea` binary.

> **Effect v4 ≠ Effect 3.x.** v4 ships *one* `effect` package: stable modules at
> the top level (`Effect`, `Layer`, `Context`, `Schema`, `Stream`, …) and beta
> APIs under `effect/unstable/*` (`rpc`, `http`, `socket`, `sql`, `cli`). The
> old `@effect/*` 3.x packages are **not** used — only the three platform/sql
> adapters above are standalone `@effect` packages.

---

## 3. Concepts you need (glossary)

Definitions are self-contained — assume no Effect knowledge — and each says
where it shows up here.

### Effect runtime primitives

- **Effect** — `Effect<A, E, R>`: a *lazy, immutable description* of a
  computation that yields `A`, may fail with a *typed* error `E`, and needs
  services `R`. Nothing runs until a runtime executes it. Written with `pipe` or
  `Effect.gen` (generator do-notation).
- **Layer** — a recipe that *builds services* (the dependency-injection graph),
  with managed setup/teardown. Composed with `Layer.provide`/`Layer.merge` and
  built **once** at startup. e.g. `Layer.effect(EventBus, EventBus.make)`.
- **Context / Tag / Service** — `Context` is the typed map of services; a *Tag*
  is the key for one. v4 declares a service as
  `class EventBus extends Context.Service<…>()(id, make)` — the class *is* the
  Tag; require it with `yield* EventBus`. **There is no auto `.Default` layer in
  v4** — every service is wired by hand with `Layer.effect`.
- **ManagedRuntime** — a long-lived, *disposable* runtime built from a Layer
  once and reused to run many Effects. The TUI and the desktop **main** process
  each build one and inject it; disposing it tears down the held connection.
- **Scope / `acquireRelease` / finalizer** — a `Scope` is a lifetime that owns
  resources and guarantees their cleanup. `Effect.acquireRelease` binds teardown
  to the enclosing scope; `Effect.addFinalizer` registers cleanup on close;
  `Effect.forkScoped` ties a background fiber to that scope. This is how the
  presence connection and the live-event fold die exactly when the runtime is
  disposed.
- **Ref / Deferred** — `Ref` is a mutable cell with atomic effectful ops;
  `Deferred` is a write-once async latch you can await. The connection tracker
  uses two `Ref`s (count, armed) and a `Deferred` (the shutdown signal).
- **SubscriptionRef** — a `Ref` whose value is *also* observable as a `Stream`
  via `.changes` (emits the current value, then every update). The client
  `ProjectStore` holds the project list in one, so the UI re-renders on change.
- **PubSub / Stream** — `PubSub` is an in-memory publish/subscribe hub (each
  subscriber gets its own queue); a `Stream` is a lazy pull-based sequence of
  values over time (the streaming counterpart of `Effect`). The backend's
  `EventBus` is a `PubSub.unbounded<DomainEvent>` exposed as a `Stream`.

### Contract, schema & transport

- **Schema** — bidirectional validation/serialization: a schema parses unknown
  input into a typed value and encodes it back, as Effects. Used for every RPC
  payload and the event log.
- **`Schema.TaggedStruct`** — a struct schema that auto-adds a literal `_tag`
  discriminator, so values form a union you can `switch` on. `ProjectCreated`
  uses it; the projection fold switches on `_tag`.
- **`Schema.fromJsonString`** — a codec that decodes-from / encodes-to a JSON
  *string* in one step. Backs the discovery file and the SQLite event payload.
- **RpcGroup / Rpc** (from `effect/unstable/rpc`) — `RpcGroup.make(Rpc.make(name,
  …), …)` declares a *typed, transport-agnostic* RPC surface from schemas. The
  single source of truth is **`YodeaRpcs`**.
- **RpcServer / RpcClient** — `RpcServer.layer(YodeaRpcs)` mounts the group as a
  WebSocket/NDJSON endpoint; `RpcClient.make(YodeaRpcs)` derives a fully-typed
  client whose methods mirror the contract (`client.ProjectList()`,
  `client.Events()` returns a `Stream`). The same `YodeaRpcs` types both ends.
- **NDJSON-over-WebSocket** — the wire format: newline-delimited JSON, one
  message per line, over a single WebSocket. Gives request/response correlation
  and server-streaming for free.

### Domain & architecture

- **Event sourcing** — state is not stored directly; every change is an
  immutable event appended to a log (the source of truth). Current state is
  derived by *folding* the log. Here the log is the SQLite `events` table.
- **CQRS** — commands (writes) and queries (reads) use different models. The
  *write* model is `DomainEvent` (carries `projectId`); the *read* model is
  `Project` (carries `id`); they are intentionally different shapes.
- **Projection / fold** — a read-model rebuilt by left-folding the event log.
  `projectsFromEvents` is a *pure* function that switches on `_tag` and
  accumulates into a `Map`. It does no I/O.
- **Architectural fitness function** — an automated test that asserts a
  *structural* property of the codebase (here: an import-graph rule) on every CI
  run, so an architecture rule is mechanically enforced, not left to reviewer
  judgement. Here it's `dependency-cruiser` wrapped in a DO-NOT-MODIFY vitest.

### Lifetime & frontends

- **Presence connection** — a long-lived streaming RPC (`Connect`) whose *only*
  purpose is to signal "a frontend is here." Opening it arms the server's
  self-shutdown; dropping it (the socket closes) is what may let the backend
  die. It carries no data — its existence *is* the signal.
- **O_EXCL lock** — opening a file with flag `"wx"` atomically creates it only if
  absent, else throws `EEXIST`. Used so exactly one concurrent frontend wins the
  right to spawn the backend (no TOCTOU race).
- **Ephemeral port** — binding port `0` lets the OS assign any free port, read
  back afterwards. Lets a freshly spawned server start while a previous one is
  still tearing down, with no `EADDRINUSE`.
- **RuntimeAdapter (port/adapter seam)** — the *one* interface that abstracts the
  two things that differ between runtimes — *how you open a WebSocket* and *how
  you spawn the backend*. `client-core` is written once against it; a **Bun**
  adapter and a **Node** adapter supply the concrete behavior.
- **Ink / contextBridge** — *Ink* is a React renderer that draws to a terminal
  instead of a DOM. *contextBridge* is Electron's secure bridge: a privileged
  "preload" script exposes a curated, typed API on `window.yodea`, and the
  sandboxed renderer can call *only* those functions — never Node, Electron, or
  the connection brain.

---

## 4. The map — three layers

The repo is `apps/*` (one folder per frontend, plus the backend) and
`packages/*` (the shared pure pieces). Dependencies point **inward**: frontends
depend only on the contract and the connection brain — never on backend
internals (that is invariant **I-1**).

```
packages/
  contracts/        @yodea/contracts     — the pure wire contract (Schemas only)
    rpc.ts  events.ts  project.ts  endpoint.ts
  client-core/      @yodea/client-core   — the runtime-agnostic connection brain
    adapter.ts            — RuntimeAdapter: the ONLY cross-runtime seam
    adapters/bun.ts       — BunSocket + Bun.spawn
    adapters/node.ts      — `ws` package + node:child_process
    discovery.ts          — find-or-spawn-under-lock (runtime-neutral)
    with-client.ts        — one-shot CLI ritual (connect → run → drop)
    project-store.ts       — long-lived live store (SubscriptionRef ← Events)
    index.ts              — barrel; deliberately does NOT re-export adapters

apps/
  cli/        BACKEND + thin CLI client
    server/ application/ domain/ db/ composition/   ← backend internals (I-1 forbidden)
    cli/                                             ← thin client (uses client-core only)
  tui/        Ink + React, on Bun
  desktop/    Electron + electron-vite + React (main / preload / renderer)
```

- **`apps/cli`** is *two things in one artifact*: the spawnable **backend**
  (`server/`, `application/`, `domain/`, `db/`, `composition/`) and a **thin CLI
  client** (`cli/`). They share the same binary — which is exactly *why* the
  import graph has to be policed (§6, I-1).
- **`packages/contracts`** is the pure, dependency-free surface both ends compile
  against. Moving it out of the app is what lets non-CLI frontends depend on it
  without reaching into `apps/cli`.
- **`packages/client-core`** is the discover → spawn → connect → presence logic,
  written *once* and reused by all three frontends through the `RuntimeAdapter`
  seam.

The rendered container view (target topology — see §10 for what is deferred):

![Containers: Desktop, CLI, and Backend, with the two clients talking to the backend](architecture/out/overall.png)

> The full C4 model lives in [`docs/architecture/yodea.c4`](architecture/yodea.c4)
> (LikeC4) with per-view D2 sources in [`docs/architecture/d2/`](architecture/d2/),
> rendered to [`docs/architecture/out/`](architecture/out/). Those diagrams depict
> the **target** system, including pieces deferred in this branch (the ACP agent
> service layer in `services.png`; the desktop state store in `desktop.png` is
> drawn as "Zustand" but the as-built renderer uses a hand-rolled hook — see §5.4).
> Treat them as the destination; this document is the as-built.

---

## 5. How it works, end to end

### 5.1 Event-sourcing / CQRS — the write and read paths

The **durable append is the commit point**; the live broadcast is best-effort.
Queries re-read and re-fold the whole log on every call (no cache).

```
  COMMAND (write side)                         QUERY (read side)
  ──────────────────                           ────────────────
  RPC ProjectCreate({name})                    RPC ProjectList()
        │                                             │
        ▼                                             ▼
  UseCases.createProject                       UseCases.listProjects
   1. newId() + createdAt                        = ProjectProjection.list
   2. build ProjectCreated                            │
        │                                             ▼
   (a) store.append  ◄═══ COMMIT POINT          EventStore.readAll
       INSERT one row into SQLite                SELECT payload ORDER BY seq ASC
        │                                             │  (re-read the WHOLE log)
   (b) bus.publish (best-effort)                      ▼
        │                                       projectsFromEvents  (pure fold)
        ▼                                             │
   PubSub ─► Events stream (NDJSON/WS)                ▼
            live subscribers ONLY                Project[]   (NO cache: re-fold each call)
            (no replay of past rows)
```

- The SQLite `events` table has `seq INTEGER PRIMARY KEY AUTOINCREMENT` — the
  **monotonic global order**. `readAll` orders by `seq ASC`, so replay order
  equals commit order.
- `append` runs *before* `publish`. If the process dies in between, the event is
  still durably committed and any future read will see it — the broadcast is
  purely a live-notification optimization.
- The `Events` stream is **live-only** (`Stream.fromPubSub`): a subscriber that
  connects *after* an event was committed never receives it over the stream.
  Frontends seed current state with `ProjectList`, then apply the live delta.
- Query/command errors are discharged with `Effect.orDie` to match the
  contract's `Schema.Never` error channel — a SQL/codec failure is a *server
  defect*, not a typed client error.
- Today `DomainEvent` is a single `TaggedStruct` aliased directly. **Growth
  path** (documented in `events.ts`): make it a `Schema.Union([…])` and add a
  `case` to the fold.

### 5.2 The lifetime dance — discover, spawn, connect, self-shutdown (I-2/I-3/I-4)

A frontend never boots the backend in-process. It discovers one, spawns it
under an exclusive lock if absent, holds a **presence** connection while it
works, and drops it — which may let the daemon die.

```
Frontend (client-core)                         Backend (yodea server)
  │ readEndpoint(server.json)? ─────────?
  │   None → tryAcquireLock (O_EXCL "wx")
  │     win  → adapter.spawnBackend (detached) ─► runServer:
  │     lose → awaitEndpoint (poll 50ms, 5s cap)     bind port 0 → read real port
  │                                                  ws://127.0.0.1:N/rpc
  │◄──────────────── server.json written (I-3) ───── after the port is bound
  │                                                  await tracker.awaitShutdown  (blocked)
  │═ open Connect stream ═════════════════════════► onConnect: count 0→1, armed=true
  │◄── one `true` (presence marker) ─────────────── Stream.make(true) ++ Stream.never
  │   ready (≤3s) → run the work                     count fluctuates, stays ≥1
  │   …other frontends connect/drop freely…
  │═ scope closes: socket drops ═══════════════════► finalizer → onDisconnect: count →0
  │                                                  armed && 0 → fire shutdown Deferred
  │                                                  eager fs.remove(server.json) (I-3)
  │                                                  close transport (~1s grace) → exit(0)
```

- **`ConnectionTracker`** is the I-4 state machine: `count: Ref<number>`,
  `armed: Ref<boolean>`, `shutdown: Deferred<void>`. `onConnect` increments and
  arms; `onDisconnect` decrements (floored at 0) and, *if armed and count hits
  0*, fires the `shutdown` Deferred once. `armed` distinguishes "0 because we
  just booted" from "0 because the last client left."
- The **`Connect` handler** is the linchpin: it runs `onConnect`, registers
  `addFinalizer(onDisconnect)` on the per-request scope, emits one `true`, then
  parks forever. When the socket drops, the RPC layer closes that scope, the
  finalizer fires, and the count decrements. **The WebSocket lifetime *is* the
  connection lifetime.**
- The composition root builds the transport in a **child scope** so it can be
  closed on demand. Three fixes make back-to-back commands reliable despite a
  ~1s Bun graceful-stop window: **ephemeral port**, **eager `server.json`
  removal** the instant shutdown arms, and a **bounded client connect-timeout +
  respawn** on a stale endpoint. (Full symptom→cause→fix list: PR review guide §7.)
- `runServer` deliberately does **not** call `process.exit` — that lives at the
  CLI entry (`commands/server.ts`), so in-process tests can run the server to
  completion.

### 5.3 One backend, many frontends — live cross-frontend updates

`ProjectStore` is the daemon-shaped counterpart to the one-shot `withClient`. It
connects once and *stays* connected, folding the live `Events` stream into a
`SubscriptionRef`. A create in one frontend reaches the others **live**:

```
  Frontend A (create "X")                     Frontend B
        │ ProjectStore.createProject("X")            ▲ live update
        ▼                                            │
   client.ProjectCreate({name:"X"})                  │ SubscriptionRef.changes
  ═══════════════════ single backend ════════════════╪══════════════════════
        │ commit ProjectCreated                       │
        ▼                                             │
   PubSub ─► Events stream (NDJSON/WS) ───────────────┴────────────┐
        │                                                          │
        ▼  each frontend's own ProjectStore                        ▼
   fold ProjectCreated → SubscriptionRef               fold → SubscriptionRef (B)
        │                                                          │
        ▼  .changes → runForEach                                   ▼  .changes → runForEach
   setState / IPC push                                  setState / IPC push (B sees "X")
```

Two details a reviewer should know:

- **The `RuntimeAdapter` seam.** `client-core` is runtime-agnostic. Two adapters
  live behind *explicit subpaths*: the **Bun** adapter (`BunSocket` + `Bun.spawn`)
  and the **Node** adapter (`makeNodeAdapter`: the `ws` npm package as the
  WebSocket constructor + `node:child_process`). The barrel (`index.ts`)
  deliberately **does not re-export the adapters**, so a Node/Electron build
  never transitively pulls `@effect/platform-bun`, and vice-versa.
- **Subscribe-before-snapshot ordering (a real bug fix).** `ProjectStore` opens
  the `Events` stream *as a queue, synchronously, before* the `ProjectList`
  snapshot. Because requests share one ordered socket, the `ProjectList`
  *response* proves the server has already registered the subscription — so a
  create that lands right after construction can't be missed. The old lazy-fork
  version raced and *happened to win on Bun but lost on the Node `ws`
  transport*, leaving the list empty.

### 5.4 The three frontends (as built)

- **CLI** (`apps/cli/cli`) — the simplest client: `withClient(bunAdapter, use)`
  does the one-shot ritual (discover/spawn → hold presence → run → drop). No
  store; commands are `health`, `project create`, `project ls`.
- **TUI** (`apps/tui`) — Ink 7 + React 19 on Bun. One `ManagedRuntime` over
  `ProjectStoreLayer(makeBunAdapter(…))`; a `useProjects` hook bridges the store
  by `runFork`-ing `Stream.runForEach(SubscriptionRef.changes, setState)` and
  interrupting on unmount. Components are pure. It resolves the backend command
  **relative to its own module** (not `Bun.main`, which would spawn a *second
  TUI*). Tested with `ink-testing-library` against a fake store.
- **Desktop** (`apps/desktop`) — Electron 42, three processes:
  - **main** owns the single connection (Node adapter + `ProjectStore` under a
    `ManagedRuntime`) and registers IPC.
  - **preload** exposes a typed `contextBridge` → `window.yodea`
    (`listProjects` / `createProject` / `onProjectsChanged`).
  - **renderer** is pure React-DOM UI over `window.yodea` only — it imports the
    *contract types* and `effect` core, but **never** `client-core` or `main`
    (the `renderer-must-not-import-client-core` rule). IPC calls are wrapped in
    `Effect.tryPromise` so a backend-down failure surfaces as a typed UI error.

  > **As-built note.** The desktop uses **ad-hoc IPC**: `ipcMain.handle` +
  > `webContents.send("project:changed", …)`. It is **not** the
  > MessagePort/`RpcServer.makeNoSerialization`/TanStack redesign in the
  > `2026-06-01-desktop-architecture-design.md` spec — that is a next iteration
  > (§10). Two known structural bugs the spec intends to fix are present today
  > (duplicate `ipcMain.handle` on a second window; a forked push fiber the
  > caller never interrupts) — see PR review guide §15.3 / §17.

---

## 6. The four invariants (I-1..I-4)

These are **load-bearing assumptions**, not guidelines. The normative text is in
[`BOUNDARIES.md`](architecture/BOUNDARIES.md); below is what each buys, where it
lives, and how *you* verify it.

| | Rule (one line) | What it buys | Enforced by | Verify it yourself |
|---|---|---|---|---|
| **I-1** | No frontend (`apps/cli/cli`, `apps/tui`, `apps/desktop`) nor `client-core` may import a backend-internal module; the renderer may not import `client-core` or `main`. Sole exception: `cli/commands/server.ts` → `composition`. | Makes a second in-process backend *physically impossible* — the import graph is the only thing preventing it. | `.dependency-cruiser.cjs` (3 `error` rules, type-aware) + DO-NOT-MODIFY fitness test + CODEOWNERS. | `bun run arch` → 0 violations. Then prove it bites (below). |
| **I-2** | At most one backend (one `AppLayer`) per machine. | One SQLite handle, one EventBus, one ConnectionTracker — no silent desync. | Mechanically implied by I-1; the O_EXCL spawn lock makes concurrent spawners converge. | `git grep -n "Layer.mergeAll\|coreLayer" apps/cli/composition/app.ts`; manual 4-way spawn (§9). |
| **I-3** | One well-known `server.json` (`url`/`token`/`pid`/`protocolVersion`), written after the port binds, removed on shutdown. | The single rendezvous that lets independent frontends find the *same* backend. | `server/endpoint-file.ts` (acquireRelease) + eager removal in `composition/app.ts`. | Watch `$YODEA_HOME/server.json` appear then vanish around a command. |
| **I-4** | Once it has had ≥1 connection, the server self-terminates the moment the count returns to 0. No grace period, no idle timer. | Spawned on demand, shared while needed, reaped immediately. Lifetime tracks *connections*, not the spawner. | `server/connection-tracker.ts` + the `Connect` finalizer + `awaitShutdown`. | `connection-tracker.test.ts` + `e2e-lifecycle.test.ts`; manual: the spawned server exits shortly after the client leaves. |

**The non-vacuity proof** — the most important thing to run, because a guard that
can't fail is no guard:

```bash
# from repo root. Add a forbidden import, confirm the rule fires, revert.
printf '\nimport "@yodea/server/http"\n' >> packages/client-core/discovery.ts
bun run arch     # EXPECT: error "frontends-must-not-import-backend"
git checkout packages/client-core/discovery.ts

printf '\nimport "@yodea/client-core"\n' >> apps/desktop/src/renderer/use-projects.ts
bun run arch     # EXPECT: error "renderer-must-not-import-client-core"
git checkout apps/desktop/src/renderer/use-projects.ts

bun run arch     # EXPECT: clean tree → 0 violations
```

The three forbidden rules use `tsPreCompilationDeps: true`, so even `import type`
edges are caught (load-bearing — the renderer imports the contract type-only):

| Rule | `from` | forbidden `to` |
|---|---|---|
| `frontends-must-not-import-backend` | `apps/cli/cli`, `apps/tui`, `apps/desktop/src`, `packages/client-core` | `apps/cli/{server,application,domain,features,infrastructure,db,services}` |
| `composition-only-from-server-subcommand` | same set **minus** `cli/commands/server.ts` | `apps/cli/composition` |
| `renderer-must-not-import-client-core` | `apps/desktop/src/renderer` | `packages/client-core`, `apps/desktop/src/main` |

> **Note for the reviewer.** `BOUNDARIES.md`'s prose still lists the old
> allowed/forbidden source folders (`apps/cli/shared`, `apps/cli/lib`) from
> before the contract moved to `packages/contracts` and the brain to
> `packages/client-core`. The **cruiser rules above are the current source of
> truth**; the doc prose is partially stale and worth a freshening pass.

---

## 7. Decisions & rationale

The decisions, each as *what was chosen* and *why*. (Process, briefly: each was
locked in a brainstorm, pressure-tested with adversarially-verified research,
specced, then built test-first — including the fitness tests, proven
non-vacuous — reviewed by dedicated subagents, and finally validated by manual
testing of the compiled binary under an isolated `YODEA_HOME`.)

1. **One backend, many thin RPC clients** — *not* each call booting its own
   in-process backend. A shared in-artifact backend is the only way to avoid
   per-call cold starts, divergent private SQLite copies, dueling agent
   subprocesses, and multi-client data divergence.
2. **Event-sourcing + CQRS** — append-only SQLite log as source of truth,
   read-models via a pure fold. Gives durability across zero-connection restarts
   and lets features grow by adding event types + fold cases, not CRUD
   migrations.
3. **Effect v4 beta (over Effect 3.x and over Commander.js)** — one typed
   contract spans Schema + RPC + streaming + Layer DI + structured concurrency
   (Commander only parses args and would force a Promise↔Effect bridge). The
   real cost — `effect/unstable/*` is beta — is **hedged**: an exact version
   pin, `skipLibCheck`, and isolating the contract in `packages/contracts` + the
   framework seam in `client-core/adapter.ts` so churn touches few files.
4. **The four invariants I-1..I-4**, with I-1 *mechanically* enforced — the
   guarantees the "one backend" idea rests on (see §6).
5. **apps-per-frontend layout + extracted `packages/{contracts,client-core}`** —
   proven correct by adding two new frontends (TUI, Electron) *without churning*
   `apps/cli` or `client-core`.
6. **A single cross-runtime seam, `RuntimeAdapter`** (`protocolLayer: Layer` +
   `spawnBackend: Effect`), with Bun and Node adapters behind separate subpaths —
   so `client-core` is written once and a build never cross-imports the other
   runtime's platform package.
7. **A `SubscriptionRef` live store + Effect-first frontends with a thin React
   shell** — the store (seeded from snapshot, folded forward by `Events`) is the
   one-backend payoff; React stays a pure projection of it. (`effect-atom` was
   *not* used — it peers on Effect v3.)
8. **Spawn-on-demand daemon with zero-connection self-shutdown, no grace period,
   ephemeral OS port, stale-tolerant spawn lock** — "zero means dead" removes a
   timer, a config knob, and a class of lingering-server bugs; the pid+timestamp
   lock stops a crashed mid-spawn process from wedging the CLI permanently.

---

## 8. Code → docs index

Every subsystem, the files that implement it, and where to read more. One line
each. Paths are repo-relative.

### `packages/contracts` — the pure wire contract

| File | Responsibility |
|---|---|
| `events.ts` | `ProjectCreated` `TaggedStruct` + `DomainEvent` (single-member alias, Union growth-path noted) + `DomainEventFromJson` codec (the JSON-string codec for the SQLite payload column — encode on append, decode on read). The `Events` RPC stream sends the plain `DomainEvent` schema via the RPC NDJSON layer, not this codec. |
| `project.ts` | `Project` read-model schema — note `id`, not `projectId`. |
| `endpoint.ts` | `Endpoint` schema, `PROTOCOL_VERSION`, `endpointFilePath()` (I-3 path, overridable via `YODEA_ENDPOINT_FILE`/`YODEA_HOME`). |
| `rpc.ts` | **`YodeaRpcs`** — the 5-procedure `RpcGroup`; streaming RPCs declare no error schema (`Schema.Never`). |

### `apps/cli` — backend core (storage → domain → application)

| File | Responsibility |
|---|---|
| `db/event-store.ts` | Append-only SQLite log: DDL (`seq` PK = global order); `append` (the commit point); `readAll` (`ORDER BY seq ASC`, whole-log, no cache). |
| `domain/project.ts` | `projectsFromEvents` — pure left-fold on `_tag`; maps `event.projectId → project.id`. |
| `application/projections.ts` | `ProjectProjection.list` = `readAll` ∘ fold — projection-on-read, no materialized table. |
| `application/event-bus.ts` | `EventBus` over `PubSub.unbounded`: `publish` (best-effort), scoped `subscribe`, live-only `stream`. |
| `application/use-cases.ts` | `createProject` (append **then** publish), `listProjects`, `health`. |

### `apps/cli` — server transport & lifetime

| File | Responsibility |
|---|---|
| `server/connection-tracker.ts` | I-4 state machine: `count`/`armed` `Ref`s + `shutdown` `Deferred`; arm-on-first-connect, fire-at-zero. |
| `server/rpc-handlers.ts` | Maps `YodeaRpcs` → use-cases; the `Connect` presence handler (per-request finalizer drives I-4); `Events` relays `bus.stream`. |
| `server/endpoint-file.ts` | I-3 `acquireRelease`: write `server.json` on acquire, remove on close. |
| `server/http.ts` | NDJSON-over-WebSocket transport on an ephemeral port; the 499-demoting access logger. |
| `composition/app.ts` | `coreLayer` (one shared graph = I-2) + `runServer` lifecycle (write-after-bind, await shutdown, eager remove, ~1s grace teardown). |

### `apps/cli/cli` — the thin CLI client (I-1)

| File | Responsibility |
|---|---|
| `cli/commands/{health,project}.ts` | The commands — each just `withClient(bunAdapter, client => …)`. |
| `cli/commands/server.ts` | The **sole** I-1 exception: imports `composition` to boot the backend; wraps `runServer` in `Effect.ensuring(process.exit(0))`. |
| `cli/main.ts` | Entry point; wires subcommands; imports no server internals. |

### `packages/client-core` — the connection brain

| File | Responsibility |
|---|---|
| `adapter.ts` | `RuntimeAdapter` — the only cross-runtime seam (`protocolLayer(url)` + `spawnBackend`). `import type` only. |
| `adapters/bun.ts` · `adapters/node.ts` | Bun (`BunSocket`+`Bun.spawn`) and Node (`ws`+`child_process`) adapters, behind explicit subpaths. |
| `discovery.ts` | `readEndpoint` (never fails → `Option`), `tryAcquireLock` (O_EXCL + stale recovery), `awaitEndpoint`, `findOrSpawnBackend(adapter)`. Runtime-neutral (`node:fs`). |
| `with-client.ts` | The one-shot ritual: connect → hold presence → bounded readiness → run → retry on `StaleEndpoint` (≤3). |
| `project-store.ts` | The live store: `SubscriptionRef<Project[]>` seeded from `ProjectList`, folded forward by `Events`; holds presence for the runtime's life. |
| `index.ts` | Barrel — re-exports the brain + the `RuntimeAdapter` *type*, **never** the adapters. |

### `apps/tui` & `apps/desktop` — the frontends

| File | Responsibility |
|---|---|
| `apps/tui/runtime.ts` | One `ManagedRuntime` over `ProjectStoreLayer(makeBunAdapter)` + `BunServices`; resolves the backend cmd via `import.meta.url` (not `Bun.main`). |
| `apps/tui/use-projects.ts` | Effect→React bridge: `SubscriptionRef.changes → setState`; `create()` forks `store.createProject`. |
| `apps/tui/{main.tsx,components/*}` | Entry + lifecycle; pure presentational `ProjectList` / `CreateInput`. |
| `apps/desktop/src/main/{runtime,ipc,index}.ts` | Node-adapter `ProjectStore`; DI'd (electron-free) IPC wiring; window + preload + dispose-on-close. |
| `apps/desktop/src/preload/{index.ts,api.d.ts}` | Typed `contextBridge` → `window.yodea` + its `.d.ts` mirror. |
| `apps/desktop/src/renderer/{App.tsx,use-projects.ts,main.tsx}` | Pure UI over `window.yodea`; `Effect.tryPromise`-wrapped IPC with seed+push race handling. |
| `apps/desktop/electron.vite.config.ts` | 3 builds; externalizes `electron`/`effect`/`@effect/*`/`ws`/node-builtins from main+preload, inlines `@yodea/*` aliases. |

### Enforcement & config

| File | Responsibility |
|---|---|
| `.dependency-cruiser.cjs` | The 3 I-1 `error` rules (type-aware); excludes `node_modules`/`test`/`out`/`dist`. |
| `test/architecture/i1-cli-isolation.test.ts` | DO-NOT-MODIFY fitness test: cruises `apps packages`, asserts no rule name appears + exit 0. |
| `CODEOWNERS` | Routes `BOUNDARIES.md`, the cruiser config, and `test/architecture/` to the architecture owners. |
| `tsconfig.json` · `vitest.config.ts` · `package.json` | Strict TS + `@yodea/*` aliases (desktop excluded); Vitest aliases + 30s timeout; pinned deps + every script. |

### Reference docs & diagrams

| Path | What |
|---|---|
| [`docs/architecture/BOUNDARIES.md`](architecture/BOUNDARIES.md) | **Normative** I-1..I-4 (rule · why · enforcement) — the contract for changing an invariant. |
| [`docs/PR-REVIEW-GUIDE.md`](PR-REVIEW-GUIDE.md) | ~1,670-line review companion: hotspots, file-by-file, runtime fixes, the five build-time bugs. |
| [`STATUS.md`](../STATUS.md) | Build log: what was built, deviations, deferred scope, green verification commands. |
| [`docs/architecture/yodea.c4`](architecture/yodea.c4) + [`d2/`](architecture/d2/) → [`out/`](architecture/out/) | LikeC4 model + D2 sources → rendered PNGs (target topology — regenerate, don't hand-edit). |
| `docs/superpowers/specs/2026-06-01-*`, `…/research/2026-06-01-*` | **Forward-looking** next-iteration plans — see §10. |

---

## 9. Build, test & review in 30 minutes

**Gates (run first, from repo root):**

```bash
bun install                  # pinned effect 4.0.0-beta.74 stack
bun run typecheck            # tsc --noEmit (strict + exactOptionalPropertyTypes + noUncheckedIndexedAccess) → 0
bun run typecheck:desktop    # apps/desktop tsconfig (DOM + Electron libs) → 0
bun run test                 # bun --bun vitest run → all green
bun run arch                 # dependency-cruiser → 0 violations (then run the §6 non-vacuity proof)
bun run build                # → dist/yodea (single binary)
bun run build:desktop        # → apps/desktop/out/{main,preload,renderer}
```

> `test` uses `bun --bun vitest` because the Node loader can't resolve
> `bun:sqlite`. The I-1 fitness test shells out to `depcruise` (~6.4s), so the
> Vitest timeout is raised to 30s in `vitest.config.ts` (config only — the
> guard itself is unchanged).

**Manual smoke (compiled binary, isolated home):**

```bash
export YODEA_HOME="$(mktemp -d)"
./dist/yodea health --json                                   # → {"status":"ok"}
./dist/yodea project create alpha && ./dist/yodea project create beta \
  && ./dist/yodea project ls --json                          # → lists BOTH (durability across self-terminating servers)
for i in 1 2 3 4; do ./dist/yodea project create "c$i" & done; wait
./dist/yodea project ls --json                               # → all four (4-way spawn converged on one backend)
```

**A 30-minute reading path** (dependency order — small files, you can read all of it):

1. **Contract** — `packages/contracts/{rpc,events,project,endpoint}.ts`. Everything depends on these.
2. **Core** — `db/event-store.ts` → `domain/project.ts` → `application/{projections,event-bus,use-cases}.ts` (§5.1).
3. **Lifetime** — `server/connection-tracker.ts` → `rpc-handlers.ts` (`Connect`) → `composition/app.ts` (§5.2).
4. **Brain** — `client-core/adapter.ts` → `adapters/*` → `discovery.ts` → `with-client.ts` → `project-store.ts` (read the subscribe-before-snapshot comment, §5.3).
5. **Frontends** — `apps/tui/{runtime,use-projects}.ts`; `apps/desktop/src/main/* → preload/* → renderer/*` (§5.4).
6. **Boundary** — `.dependency-cruiser.cjs` + the fitness test; **run the §6 non-vacuity proof**.

For *finding problems*, jump to **PR review guide §8 / §18a** (prioritized hotspots).

---

## 10. Scope — deferred & forward-looking

**Deliberately deferred in this branch** (scaffolding is in place; these are not
missing work):

- Real backend services — Git, Terminal, FileWatcher, Highlighter, DiffParser,
  the ACP client — and the per-project `TxQueue`.
- The ACP agent loop (an agent invoking the `yodea` CLI as a tool).
- OS-keychain secrets (only env config is built; the endpoint `token` is a
  no-op today).
- Historical-event replay on the `Events` stream (live-only by contract).
- Packaging / installers / code-signing; multiple event types (`Schema.Union`);
  project rename/delete; auth beyond the token.

**Forward-looking plans — specced, NOT in this PR** (cite for rationale only):

- `docs/superpowers/specs/2026-06-01-tui-architecture-design.md` — a chat-first
  TUI redesign (status line + swappable region + always-mounted `/command`
  composer). The as-built TUI is the simpler `ProjectList`/`CreateInput` +
  `useProjects` bridge.
- `docs/superpowers/specs/2026-06-01-desktop-architecture-design.md` — an Electron
  redesign (per-window `MessageChannelMain` + `RpcServer.makeNoSerialization` +
  TanStack Query/Router + sandboxed CommonJS preload). The as-built desktop uses
  the `contextBridge`/`ipcMain.handle` IPC described in §5.4.
- `docs/superpowers/research/2026-06-01-cli-architecture-research.md` — an
  agent-first CLI output contract (versioned JSON envelopes, tagged-error→exit-code
  taxonomy). Today the CLI emits ad-hoc `--json`.

**Known limitation (not a decision):** last-client shutdown takes ~1s (the
documented Bun graceful-stop grace window) — distinct from the I-4 "no grace
*period*" decision; it's a Bun-deadlock workaround, not an idle timeout.
