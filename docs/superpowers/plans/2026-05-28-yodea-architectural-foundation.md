# Yodea Architectural Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the CLI-only *walking skeleton* of Yodea — a single long-lived Effect backend that owns all state, a thin `effect/unstable/cli` RPC client that discovers/spawns/connects over WebSocket, an event-sourced SQLite store, and automated enforcement of all four architectural invariants (I-1..I-4) — proving every architectural seam end-to-end with one trivial domain (`Session`).

**Architecture:** One process hosts the Effect `AppLayer` (`yodea server`); every other process is a thin WebSocket frontend (I-2). Use-cases form a hexagonal core that commits `DomainEvent`s to an append-only SQLite event log (source of truth) and broadcasts them on an `Effect.PubSub` bus; read-models are projections rebuilt from the log. The backend advertises itself via a single discovery file (I-3) and shuts down the instant its WebSocket connection count returns to zero (I-4). The CLI is import-isolated from all server internals (I-1), enforced by a `dependency-cruiser` fitness test that is treated as part of the specification.

**Tech Stack:** TypeScript · Bun · Effect v4 (single `effect` package) · `effect/unstable/rpc` (WebSocket/NDJSON) · `effect/unstable/cli` · `@effect/platform-bun` · `@effect/sql-sqlite-bun` (WAL) · `vitest` · `dependency-cruiser`.

**Verified version set (May 2026 — pin these, then `bun pm ls` to confirm post-install):**

```
effect@4.0.0-beta.74
@effect/platform-bun@4.0.0-beta.74
@effect/sql-sqlite-bun@4.0.0-beta.74

# devDependencies:
typescript@6.0.3
vitest@4.1.7
dependency-cruiser@17.4.2
@types/bun@1.3.14
@types/node@25.9.1
```

> In Effect v4 the stack collapses into the single `effect` package: the former `@effect/platform`, `@effect/cli`, `@effect/rpc`, `@effect/sql`, and `@effect/experimental` packages **no longer exist** — their code now lives under `effect` core (e.g. `Schema`, `FileSystem`, `Path`) or `effect/unstable/*` (`effect/unstable/rpc`, `effect/unstable/cli`, `effect/unstable/socket`, `effect/unstable/http`, `effect/unstable/sql/*`). Only the platform adapters remain separate packages — `@effect/platform-bun` (`BunRuntime`, `BunServices`, `BunHttpServer`, `BunSocket`) and `@effect/sql-sqlite-bun` (`SqliteClient`, `SqliteMigrator`) — and they re-export their types from `effect/unstable/*`. Do **not** add the old separate packages to `package.json`.

> **API-volatility note for implementers.** This plan targets the Effect **v4 beta** (`effect@4.0.0-beta.74`). Two compounding sources of churn apply. First, everything used here outside of `effect` core lives under `effect/unstable/*` — that namespace is explicitly *unstable* and its shapes can change without a stable-API guarantee. Second, the whole stack is a **beta**: import paths, layer constructors, and option bags can drift between betas (e.g. `Effect.fork` → `Effect.forkChild`, `Schema.parseJson` → `Schema.fromJsonString`, `Options`/`Args` → `Flag`/`Argument`, no auto `.Default` layer). The code in this plan is written against the version set above and was cross-checked against the installed package `.d.ts` sources in `node_modules/effect/dist/**` (plus `@effect/platform-bun` and `@effect/sql-sqlite-bun`) in May 2026. Two areas are explicitly called out as "verify against installed version" where the API is most likely to drift: (a) the `effect/unstable/rpc` WebSocket **client** transport wiring (Phase 5/6) — note WS = `RpcClient.layerProtocolSocket()` + `BunSocket.layerWebSocket(url)`, not a client `layerProtocolWebsocket`; and (b) observing per-connection WebSocket lifecycle for I-4 (Phase 5). Each such step contains a fallback. Everywhere else, treat the code as literal — but when a `tsc` error points at an `effect/unstable/*` symbol, re-grep the installed `.d.ts` before assuming the plan is wrong.

---

## Architectural decisions locked before planning

These were chosen deliberately; they shape the tasks below.

1. **Runtime: Bun.** TS-native, `bun:sqlite` via `@effect/sql-sqlite-bun` (no native build step), and `bun build --compile` is the path to the single CLI+backend artifact that I-1 assumes. Backend & CLI share one Bun package; the (future) Electron desktop is a *separate* process that only ever speaks WebSocket, so it shares no runtime or native module with the backend — only the pure-Schema contracts in `backend/shared/**`.
2. **Scope: CLI-only walking skeleton.** No Electron, no real services (Git/Terminal/FileWatcher/Highlighter/DiffParser/ACP) yet. Those are additive and do **not** alter the core seams this foundation establishes. Every I-1..I-4 invariant *is* in scope.
3. **Persistence: event-sourced with one projection.** The `events` table is the source of truth. The `Session` read-model is a projection rebuilt by folding the event log. This proves the event-sourcing machinery without over-building.
4. **CLI framework: `effect/unstable/cli`** (per the C4 model, not commander.js).

### Write-path decision (a deliberate, documented refinement of the C4)

The C4 shows both `useCases -> storage` and `eventBus -> storage 'persists event log'`. Taken literally, persistence-via-bus-subscriber introduces eventual consistency (a query issued immediately after a command might miss its own write). For a *reliable* foundation we make the durable append the commit point:

> **A use-case commits an event by (1) appending it to the `EventStore` — the durable, synchronous source of truth — and then (2) publishing it to the `EventBus` for live subscribers.** Queries read projections derived from the `EventStore`, never from the bus. The bus is a live-notification fan-out, not the persistence path.

This honors the *intent* of the C4 (events flow to storage and to subscribers) while removing the read-your-writes race. It is recorded here as the architecture decision that the `eventBus -> storage` arrow is realized as "use-case appends, then publishes," not "subscriber persists."

---

## File Structure

Source root is `backend/` and tests live under `test/` — exactly the paths the invariants in `BOUNDARIES.md` reference. Each file has one responsibility; files that change together live together.

```
yodea/
├─ package.json                      # Bun package: name "yodea", bin -> dist/cli entry; scripts
├─ tsconfig.json                     # strict; moduleResolution "bundler"
├─ vitest.config.ts                  # test runner config
├─ .dependency-cruiser.cjs           # I-1 forbidden-rule config (part of the spec)
├─ CODEOWNERS                        # routes test/architecture/** to architecture owners
├─ migrations/
│  └─ 0001_create_events.ts          # event-log DDL (Effect migration)
├─ backend/
│  ├─ shared/                        # PURE contracts — importable by BOTH cli and server (I-1 allows)
│  │  ├─ events.ts                   #   DomainEvent schema (Schema.Union of TaggedStructs)
│  │  ├─ rpc.ts                      #   RpcGroup contract (Health, Session.Create/List, Events stream)
│  │  └─ endpoint.ts                 #   Endpoint schema (url/token/pid/protocolVersion) + well-known path
│  ├─ lib/                           # low-level helpers genuinely shared (no domain/server deps)
│  │  └─ ids.ts                      #   id generation
│  ├─ domain/                        # entities + pure decision logic (no I/O)
│  │  └─ session.ts                  #   Session read-model type + pure event-fold (projection step)
│  ├─ db/                            # storage adapters
│  │  └─ event-store.ts              #   SqliteClient layer + EventStore service (append / readAll)
│  ├─ application/                   # hexagonal core: use-cases + the event bus
│  │  ├─ event-bus.ts                #   EventBus service (PubSub<DomainEvent>: publish + stream)
│  │  ├─ projections.ts              #   SessionProjection service (fold events -> Session[])
│  │  └─ use-cases.ts                #   UseCases service: health, createSession, listSessions
│  ├─ server/                        # transport + lifetime (server-only)
│  │  ├─ rpc-handlers.ts             #   maps RpcGroup -> UseCases (RpcServer handler layer)
│  │  ├─ connection-tracker.ts       #   I-4 state machine: Ref<count> + armed + shutdown trigger
│  │  ├─ endpoint-file.ts            #   I-3: acquireRelease writes/removes server.json
│  │  └─ http.ts                     #   BunHttpServer + RpcServer WS protocol + connection bracketing
│  ├─ composition/                   # THE AppLayer. The only thing cli/commands/server.ts may import
│  │  └─ app.ts                      #   runServer: wires db + application + server into one launch
│  └─ cli/                           # thin client — must NEVER import server-only modules (I-1)
│     ├─ discovery.ts                #   read/validate endpoint file; find-or-spawn under lock
│     ├─ rpc-client.ts              #   RpcClient over WebSocket to the discovered backend
│     ├─ commands/
│     │  ├─ health.ts                #   `yodea health [--json]`
│     │  ├─ session.ts               #   `yodea session create|ls [--json]`
│     │  └─ server.ts                #   `yodea server` — ONLY cli file allowed to import composition
│     └─ main.ts                     #   effect/unstable/cli root command + BunRuntime.runMain entrypoint
└─ test/
   ├─ architecture/
   │  └─ i1-cli-isolation.test.ts    # DO NOT MODIFY — wraps dependency-cruiser (I-1)
   ├─ unit/                          # fast, pure: domain fold, connection-tracker state machine, schemas
   └─ integration/                   # in-process boot: event loop, RPC roundtrip, lifetime (I-2/I-4)
```

---

## Subagent Orchestration

This plan is executed by three **persistent specialized subagents** created in Phase 0 (`.claude/agents/*.md`). Every implementation task names which agent runs it. The orchestrator (you, in the main session) dispatches one task at a time, reviews between tasks, and never lets a task be marked done on the implementer's say-so alone.

| Agent | File | Role | Invoked for |
|---|---|---|---|
| **tdd-implementer** | `.claude/agents/tdd-implementer.md` | Writes the failing test first, runs it to confirm it fails for the right reason, writes the minimal code to pass, re-runs, commits. Never writes implementation before a red test. | Every task with a "Write the failing test" step. |
| **code-reviewer** | `.claude/agents/code-reviewer.md` | Reviews a completed task's diff against the task's intent, the C4 model, and `BOUNDARIES.md`. Blocks on correctness bugs, invariant violations, or placeholder code. Read-only. | After each phase (and after any task touching an invariant). |
| **manual-tester** | `.claude/agents/manual-tester.md` | Drives the *real* compiled `yodea` binary in a terminal — spawns the server, runs commands, inspects `server.json`, kills connections, asserts process exit. Reports observed behavior, not intentions. | I-3/I-4 behavioral verification and the end-to-end slice (Phase 7). |

**Two-stage review per phase:** (1) `tdd-implementer` self-verifies (tests green, see `superpowers:verification-before-completion`); (2) `code-reviewer` independently audits the diff. Only after stage 2 passes does the orchestrator advance.

**Dispatch contract.** Because subagents start with zero context, every dispatch must include: the task's full text (files, steps, code), the relevant invariant text from `BOUNDARIES.md` if applicable, and "report the exact commands you ran and their output." Trust-but-verify: the orchestrator re-reads the actual diff before advancing.

---

## Working branch — keep `develop` clean

**`develop` must stay clean: never commit to it directly.** Before Task 0.1, create a dedicated working branch (or an isolated worktree) and land *every* commit in this plan there. Integrate back into `develop` via a reviewed PR / merge at the very end (see the closing handoff).

```bash
# from the repo root, on an up-to-date develop:
git switch -c feat/architectural-foundation

# OR, for full isolation (superpowers:using-git-worktrees):
#   git worktree add ../yodea-foundation -b feat/architectural-foundation
#   cd ../yodea-foundation
```

Every `git commit` step below targets this feature branch, never `develop`. Subagents inherit the branch from the working directory, so create it once, up front — and confirm with `git branch --show-current` before dispatching the first implementer.

---

## Phase 0 — Scaffold, tooling, and subagent definitions

**Outcome:** A Bun project that type-checks, runs an empty vitest suite green, has the full `backend/**` + `test/**` directory skeleton, and has the three subagent definitions on disk.

### Task 0.1: Initialize the Bun package and pin dependencies

**Agent:** tdd-implementer (no test here — this is scaffolding; verify via `bun install` + `bunx tsc --noEmit`).

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`

- [ ] **Step 1: Create `package.json`**

The Effect stack is now a single `effect` package — the v4 betas of `@effect/platform`, `@effect/cli`, `@effect/rpc`, and `@effect/sql` DO NOT EXIST as standalone packages; their code lives under `effect/unstable/*` or `effect` core. Only the Bun platform adapter (`@effect/platform-bun`) and the SQLite-Bun adapter (`@effect/sql-sqlite-bun`) remain separate packages. All three Effect packages are pinned to the same beta (`4.0.0-beta.74`).

```json
{
  "name": "yodea",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "module": "backend/cli/main.ts",
  "bin": { "yodea": "backend/cli/main.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "arch": "depcruise backend --config .dependency-cruiser.cjs",
    "build": "bun build backend/cli/main.ts --compile --outfile dist/yodea"
  },
  "dependencies": {
    "effect": "4.0.0-beta.74",
    "@effect/platform-bun": "4.0.0-beta.74",
    "@effect/sql-sqlite-bun": "4.0.0-beta.74"
  },
  "devDependencies": {
    "typescript": "6.0.3",
    "vitest": "4.1.7",
    "dependency-cruiser": "17.4.2",
    "@types/bun": "1.3.14",
    "@types/node": "25.9.1"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

`skipLibCheck: true` is **load-bearing** for Effect v4: the v4 `.d.ts` files do not survive a strict lib check under `lib: ["ES2022"]` (≈40 errors). Keep `moduleResolution: "bundler"` — Effect v4 `.d.ts` files import internal modules with explicit `.ts` extensions, which `bundler` (or `nodenext`) resolves but `node`/`classic` would not. `"node"` is in `types` so `@types/node` is picked up.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["bun", "node"],
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "noEmit": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "baseUrl": ".",
    "paths": { "@yodea/*": ["backend/*"] }
  },
  "include": ["backend", "test", "migrations", "vitest.config.ts"]
}
```

- [ ] **Step 3: Install and verify**

Run: `bun install`
Then: `bunx tsc --noEmit`
Expected: install succeeds; `tsc` exits 0 (no source files yet → nothing to fail). If any pinned version 404s, run `bun pm ls` and adjust to the nearest published beta, recording the change. (The `@effect/platform-bun` and `@effect/sql-sqlite-bun` pins were read from their installed `node_modules/**/package.json` — confirm they resolve to `4.0.0-beta.74`.)

- [ ] **Step 4: Commit**

```bash
git add package.json tsconfig.json bun.lock
git commit -m "chore: initialize Bun package with pinned Effect stack"
```

### Task 0.2: Create the directory skeleton

**Agent:** tdd-implementer.

**Files:**
- Create: every directory in the File Structure map, each seeded with an `index.ts` that re-exports nothing yet OR a `.gitkeep`. Use real module files where later tasks fill them; use `.gitkeep` for `test/unit`, `test/integration`.

- [ ] **Step 1: Create placeholder modules so imports resolve and dirs are tracked**

Create these files, each containing exactly `export {}`:
`backend/shared/events.ts`, `backend/shared/rpc.ts`, `backend/shared/endpoint.ts`, `backend/lib/ids.ts`, `backend/domain/session.ts`, `backend/db/event-store.ts`, `backend/application/event-bus.ts`, `backend/application/projections.ts`, `backend/application/use-cases.ts`, `backend/server/rpc-handlers.ts`, `backend/server/connection-tracker.ts`, `backend/server/endpoint-file.ts`, `backend/server/http.ts`, `backend/composition/app.ts`, `backend/cli/discovery.ts`, `backend/cli/rpc-client.ts`, `backend/cli/commands/health.ts`, `backend/cli/commands/session.ts`, `backend/cli/commands/server.ts`, `backend/cli/main.ts`.

Create empty `.gitkeep` in `test/unit/` and `test/integration/`.

- [ ] **Step 2: Verify type-check still passes**

Run: `bunx tsc --noEmit`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add backend test
git commit -m "chore: scaffold backend and test directory skeleton"
```

### Task 0.3: Configure vitest and prove the harness

**Agent:** tdd-implementer.

**Files:**
- Create: `vitest.config.ts`
- Test: `test/unit/harness.test.ts`

- [ ] **Step 1: Create `vitest.config.ts`**

vitest 4 keeps `defineConfig` from `vitest/config`, `test.include`, and `resolve.alias` unchanged. The `@yodea` alias is required because tsconfig `paths` are not read at runtime. (vitest 4 requires Vite `^6 || ^7 || ^8` and Node ≥20, both satisfied by the pinned stack.)

```ts
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    globals: false
  },
  resolve: {
    alias: { "@yodea": new URL("./backend", import.meta.url).pathname }
  }
})
```

- [ ] **Step 2: Write the failing test**

```ts
// test/unit/harness.test.ts
import { describe, expect, it } from "vitest"

describe("test harness", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2)
  })
})
```

- [ ] **Step 3: Run it**

Run: `bun run test`
Expected: 1 passed. (Confirms vitest + Bun + TS wiring.)

- [ ] **Step 4: Commit**

```bash
git add vitest.config.ts test/unit/harness.test.ts
git commit -m "test: add vitest harness"
```

### Task 0.4: Write the three persistent subagent definitions

**Agent:** orchestrator writes these directly (they define the other agents).

**Files:**
- Create: `.claude/agents/tdd-implementer.md`
- Create: `.claude/agents/code-reviewer.md`
- Create: `.claude/agents/manual-tester.md`

- [ ] **Step 1: Create `.claude/agents/tdd-implementer.md`**

```markdown
---
name: tdd-implementer
description: Implements a single planned task using strict TDD on the Yodea codebase (Bun + Effect v4 beta). Writes the failing test first, confirms it fails for the right reason, writes minimal code to pass, re-runs, commits.
tools: Read, Edit, Write, Bash, Grep, Glob
---

You implement exactly ONE task from the Yodea implementation plan, no more.

Rules:
- TDD is non-negotiable. Write the failing test FIRST. Run it. Confirm it fails for the REASON the task expects (not a typo/import error unless that is the expected failure).
- Then write the MINIMAL code to make it pass. Re-run. Confirm green.
- Run `bunx tsc --noEmit` before committing. It must pass.
- Respect BOUNDARIES.md. If the task is in `backend/cli/**`, you may import ONLY from `backend/shared/**`, `backend/lib/**`, or npm — never server internals.
- Use Effect v4 beta APIs: import from `effect`, `effect/unstable/*`, `@effect/platform-bun`, and `@effect/sql-sqlite-bun` only. Services are `Context.Service`; wire layers explicitly with `Layer.effect(X, X.make)` (there is no auto `.Default`). Do not use removed 3.x APIs (`Effect.Service`, `Context.Tag`, `Effect.fork`, `Effect.zipRight`, `Schema.parseJson`, `@effect/rpc`/`@effect/cli`/`@effect/sql`/`@effect/platform` package imports).
- Do not add features, abstractions, or error handling beyond what the task's test requires.
- Commit with the exact message in the task.
- Report: the exact commands you ran, their output (pass/fail counts), and the final diff. Never claim success without showing the passing test output.
```

- [ ] **Step 2: Create `.claude/agents/code-reviewer.md`**

```markdown
---
name: code-reviewer
description: Independently reviews a completed Yodea task's diff for correctness bugs, invariant violations (BOUNDARIES.md I-1..I-4), and placeholder code. Read-only — reports findings, does not fix.
tools: Read, Bash, Grep, Glob
---

You review the diff produced by a just-completed task. You did not write it.

Check, in order:
1. Correctness: does the code do what the task intended? Any logic bugs, race conditions, unhandled error channels?
2. Invariants (BOUNDARIES.md): does anything under `backend/cli/**` import a server module (I-1)? Is there more than one place constructing the AppLayer (I-2)? Is the endpoint file written/removed via acquireRelease (I-3)? Is the connection-count shutdown logic correct — armed only after first connect, fires exactly at zero (I-4)?
3. Spec fidelity: does it match the C4 model's component responsibilities?
4. Effect v4 usage: services via `Context.Service` with explicit `Layer.effect(X, X.make)` layers (no auto `.Default`); imports only from `effect`/`effect/unstable/*`/`@effect/platform-bun`/`@effect/sql-sqlite-bun`; no removed 3.x APIs (`Effect.Service`, `Context.Tag`, `Effect.fork`, `Effect.zipRight`, `Schema.parseJson`, `@effect/rpc`/`@effect/cli`/`@effect/sql`/`@effect/platform`).
5. Placeholders: any TODO, stubbed return, `as any`, or test that asserts nothing.

Run `bun run test`, `bunx tsc --noEmit`, and `bun run arch` yourself and report results.
Output a verdict: APPROVE or BLOCK with a numbered list of required changes. Be specific (file:line). Do not perform fixes.
```

- [ ] **Step 3: Create `.claude/agents/manual-tester.md`**

```markdown
---
name: manual-tester
description: Drives the real compiled `yodea` binary in a terminal to verify runtime behavior and invariants I-3/I-4 that cannot be unit-tested. Reports observed behavior with evidence.
tools: Read, Bash, Grep, Glob
---

You verify RUNTIME behavior of the real `yodea` binary — not unit logic.

Method:
- Build first: `bun run build` (produces `dist/yodea`), or run via `bun backend/cli/main.ts <args>` if a compiled binary is not yet expected.
- Use a scratch HOME/config dir so the discovery file path is isolated (the task tells you the env var).
- For each check, run the actual command, then inspect real artifacts: does `server.json` exist and contain a live pid? Does a second command reuse the same pid (I-2)? When the last connection closes, does the process exit within ~1s and is `server.json` removed (I-4)?
- Capture: exact commands, exit codes, file contents (`cat server.json`), process listings (`ps`/`pgrep`), and timing.

Report a table of check -> expected -> observed -> PASS/FAIL. Never infer; only report what you actually observed. Clean up any servers you spawned.
```

- [ ] **Step 4: Commit**

```bash
git add .claude/agents
git commit -m "chore: add tdd-implementer, code-reviewer, manual-tester subagents"
```

**Phase 0 review gate:** dispatch `code-reviewer` to confirm the scaffold type-checks, the harness test passes, and the three agent files are well-formed. Advance only on APPROVE.

---

## Phase 1 — Invariant I-1: CLI client isolation (static fitness test)

**Outcome:** A `dependency-cruiser` rule + a "DO NOT MODIFY" vitest wrapper that fails CI if any `backend/cli/**` file imports a server-only module, *and* a demonstrated proof that the guard actually bites. This is written now, before any real code, so it is green from the first line of source and red the moment the boundary is crossed. Per `BOUNDARIES.md`, this test is part of the **specification**.

### Task 1.1: Author the dependency-cruiser forbidden rules

**Agent:** tdd-implementer.

**Files:**
- Create: `.dependency-cruiser.cjs`

- [ ] **Step 1: Create `.dependency-cruiser.cjs`**

```js
// Architectural fitness config — enforces BOUNDARIES.md I-1.
// Two rules together encode: backend/cli/** may import ONLY shared/, lib/, npm;
// the SOLE exception is backend/cli/commands/server.ts importing backend/composition/**.
module.exports = {
  forbidden: [
    {
      name: "cli-client-must-not-import-server",
      severity: "error",
      comment:
        "BOUNDARIES.md I-1: backend/cli/** must never import server-only modules. " +
        "The CLI is a thin RPC client; it may import only backend/shared, backend/lib, or npm.",
      from: { path: "^backend/cli/" },
      to: {
        path:
          "^backend/(server|application|domain|features|infrastructure|db|services)(/|$)"
      }
    },
    {
      name: "cli-composition-only-from-server-subcommand",
      severity: "error",
      comment:
        "BOUNDARIES.md I-1: only backend/cli/commands/server.ts may import backend/composition/**, " +
        "and only to boot the backend.",
      from: {
        path: "^backend/cli/",
        pathNot: "^backend/cli/commands/server\\.ts$"
      },
      to: { path: "^backend/composition(/|$)" }
    }
  ],
  options: {
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(node_modules|test)" }
  }
}
```

- [ ] **Step 2: Run the cruiser against the (clean) skeleton**

Run: `bun run arch`
Expected: exit 0, `no dependency violations found`. (No cli file imports anything yet.)

- [ ] **Step 3: Commit**

```bash
git add .dependency-cruiser.cjs package.json
git commit -m "build: add dependency-cruiser I-1 forbidden rules"
```

### Task 1.2: The DO-NOT-MODIFY vitest wrapper

**Agent:** tdd-implementer.

**Files:**
- Test: `test/architecture/i1-cli-isolation.test.ts`

- [ ] **Step 1: Write the test (it should PASS on the clean codebase)**

```ts
// test/architecture/i1-cli-isolation.test.ts
// ============================================================================
// DO NOT MODIFY — architectural invariant I-1 (see docs/architecture/BOUNDARIES.md).
// This test is part of the SPECIFICATION, not the implementation. Changing or
// relaxing it changes the system's guarantees and requires an architecture-
// decision document plus architecture-owner review. CODEOWNERS routes this path.
// ============================================================================
import { execFileSync } from "node:child_process"
import { describe, expect, it } from "vitest"

describe("I-1: CLI client isolation", () => {
  it("backend/cli/** does not import server-only modules", () => {
    let output = ""
    let code = 0
    try {
      output = execFileSync(
        "bunx",
        ["depcruise", "backend", "--config", ".dependency-cruiser.cjs"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
      )
    } catch (e: any) {
      code = typeof e.status === "number" ? e.status : 1
      output = `${e.stdout ?? ""}${e.stderr ?? ""}`
    }
    expect(output).not.toContain("cli-client-must-not-import-server")
    expect(output).not.toContain("cli-composition-only-from-server-subcommand")
    expect(code).toBe(0)
  })
})
```

- [ ] **Step 2: Run it**

Run: `bun run test -- test/architecture/i1-cli-isolation.test.ts`
Expected: 1 passed.

- [ ] **Step 3: Commit**

```bash
git add test/architecture/i1-cli-isolation.test.ts
git commit -m "test: add DO-NOT-MODIFY I-1 architecture fitness test"
```

### Task 1.3: Prove the guard bites (adversarial verification, then revert)

**Agent:** tdd-implementer. This is the red half of red-green for an enforcement test: a guard you never saw fail is a guard you don't trust.

**Files:**
- Temporarily Modify: `backend/cli/discovery.ts` (reverted at the end — no commit of the violation)

- [ ] **Step 1: Introduce a deliberate violation**

Replace the contents of `backend/cli/discovery.ts` with an illegal import:

```ts
// TEMPORARY — proving the I-1 guard fails. Reverted in Step 4.
import "@yodea/composition/app"
export {}
```

- [ ] **Step 2: Run the cruiser and the test — expect RED**

Run: `bun run arch`
Expected: exit non-zero, output contains `cli-composition-only-from-server-subcommand` (discovery.ts is not the server subcommand).
Run: `bun run test -- test/architecture/i1-cli-isolation.test.ts`
Expected: 1 failed.

- [ ] **Step 3: Try the other forbidden target — expect RED**

Replace `backend/cli/discovery.ts` with:

```ts
import "@yodea/server/http"
export {}
```

Run: `bun run arch`
Expected: output contains `cli-client-must-not-import-server`.

- [ ] **Step 4: Revert and confirm GREEN**

Restore `backend/cli/discovery.ts` to exactly `export {}`.
Run: `bun run arch` → exit 0.
Run: `bun run test` → all passed.

- [ ] **Step 5: Commit (only the revert — the violation is never committed)**

```bash
git add backend/cli/discovery.ts
git commit -m "test: verify I-1 guard rejects forbidden cli imports (adversarial check)"
```

### Task 1.4: Route the invariant through CODEOWNERS

**Agent:** tdd-implementer.

**Files:**
- Create: `CODEOWNERS`

- [ ] **Step 1: Create `CODEOWNERS`**

> Replace `@your-org/architecture-owners` with the real GitHub team or usernames before this repo goes multi-contributor. The point (per `BOUNDARIES.md`) is that any change to the invariant or its enforcement triggers architecture-owner review.

```
# Architectural invariants — changes require architecture-owner review.
# See docs/architecture/BOUNDARIES.md ("Modifying these invariants").
/docs/architecture/BOUNDARIES.md   @your-org/architecture-owners
/.dependency-cruiser.cjs           @your-org/architecture-owners
/test/architecture/                @your-org/architecture-owners
```

- [ ] **Step 2: Commit**

```bash
git add CODEOWNERS
git commit -m "chore: route architecture invariants to CODEOWNERS"
```

**Phase 1 review gate:** dispatch `code-reviewer`. It must confirm: (a) both forbidden rules match the exact dir list in `BOUNDARIES.md` I-1, (b) the `server.ts` exception is correctly scoped, (c) the test carries the DO-NOT-MODIFY header, (d) the adversarial proof was actually run (check the commit history shows the revert). Advance only on APPROVE.

---

## Phase 2 — Shared contracts (pure Effect Schema)

**Outcome:** The `backend/shared/**` and `backend/lib/**` modules: domain-event schema, the `Session` read-model schema, the endpoint/discovery schema + path, and the `effect/unstable/rpc` group. These are pure (Schema + node stdlib only) so both the CLI and the server may import them without violating I-1.

> **File-map refinement:** the `Session` read-model *type* lives in a new pure module `backend/shared/session.ts` (Schema only, no `effect/unstable/rpc`), so the `backend/domain/**` fold can import the type without dragging `effect/unstable/rpc` into the domain. `backend/shared/rpc.ts` imports `Session` from there. This supersedes the map's note that the type lived in `domain/session.ts` (which now holds only the *fold*).

### Task 2.1: Id helper

**Agent:** tdd-implementer.

**Files:**
- Modify: `backend/lib/ids.ts`
- Test: `test/unit/ids.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/ids.test.ts
import { describe, expect, it } from "vitest"
import { newId } from "@yodea/lib/ids"

describe("newId", () => {
  it("returns a uuid-shaped string", () => {
    expect(newId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })
  it("is unique across calls", () => {
    expect(newId()).not.toBe(newId())
  })
})
```

- [ ] **Step 2: Run it — expect FAIL** (`newId` is not exported).

Run: `bun run test -- test/unit/ids.test.ts`
Expected: FAIL — "newId is not a function" / import error.

- [ ] **Step 3: Implement `backend/lib/ids.ts`**

```ts
export const newId = (): string => crypto.randomUUID()
```

- [ ] **Step 4: Run it — expect PASS.** `bun run test -- test/unit/ids.test.ts` → 2 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/lib/ids.ts test/unit/ids.test.ts
git commit -m "feat: add id helper"
```

### Task 2.2: Domain event schema

**Agent:** tdd-implementer.

**Files:**
- Modify: `backend/shared/events.ts`
- Test: `test/unit/events.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/events.test.ts
import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { DomainEventFromJson, SessionCreated } from "@yodea/shared/events"

describe("DomainEvent", () => {
  it("constructs SessionCreated with an auto-filled _tag", () => {
    const e = SessionCreated.make({
      sessionId: "s1",
      title: "First",
      createdAt: "2026-01-01T00:00:00.000Z"
    })
    expect(e._tag).toBe("SessionCreated")
    expect(e.title).toBe("First")
  })

  it("roundtrips through JSON text", () => {
    const e = SessionCreated.make({
      sessionId: "s1",
      title: "First",
      createdAt: "2026-01-01T00:00:00.000Z"
    })
    const json = Schema.encodeSync(DomainEventFromJson)(e)
    expect(typeof json).toBe("string")
    expect(Schema.decodeUnknownSync(DomainEventFromJson)(json)).toEqual(e)
  })
})
```

- [ ] **Step 2: Run it — expect FAIL** (nothing exported yet).

Run: `bun run test -- test/unit/events.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `backend/shared/events.ts`**

```ts
import { Schema } from "effect"

// One event type today. As the domain grows, replace the alias below with
// `Schema.Union([SessionCreated, SessionRenamed, ...])`; the projection fold
// already switches on `_tag`, so adding a case is the only other change.
export const SessionCreated = Schema.TaggedStruct("SessionCreated", {
  sessionId: Schema.String,
  title: Schema.String,
  createdAt: Schema.String
})

export const DomainEvent = SessionCreated
export type DomainEvent = typeof DomainEvent.Type
export type DomainEventEncoded = Schema.Codec.Encoded<typeof DomainEvent>

// Encode/decode a DomainEvent to/from JSON text (used by the event log and RPC).
export const DomainEventFromJson = Schema.fromJsonString(DomainEvent)
```

- [ ] **Step 4: Run it — expect PASS.** `bun run test -- test/unit/events.test.ts` → 2 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/shared/events.ts test/unit/events.test.ts
git commit -m "feat: add DomainEvent schema (SessionCreated)"
```

### Task 2.3: Session read-model schema

**Agent:** tdd-implementer.

**Files:**
- Create: `backend/shared/session.ts`
- Test: `test/unit/session-schema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/session-schema.test.ts
import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { Session } from "@yodea/shared/session"

describe("Session schema", () => {
  it("decodes a well-formed session", () => {
    const s = Schema.decodeUnknownSync(Session)({
      id: "s1",
      title: "First",
      createdAt: "2026-01-01T00:00:00.000Z"
    })
    expect(s.id).toBe("s1")
  })

  it("rejects a session missing a field", () => {
    expect(() => Schema.decodeUnknownSync(Session)({ id: "s1" })).toThrow()
  })
})
```

- [ ] **Step 2: Run it — expect FAIL.** `bun run test -- test/unit/session-schema.test.ts`

- [ ] **Step 3: Implement `backend/shared/session.ts`**

```ts
import { Schema } from "effect"

export const Session = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  createdAt: Schema.String
})
export type Session = typeof Session.Type
```

- [ ] **Step 4: Run it — expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add backend/shared/session.ts test/unit/session-schema.test.ts
git commit -m "feat: add Session read-model schema"
```

### Task 2.4: Endpoint (discovery file) schema + path — I-3 data contract

**Agent:** tdd-implementer.

**Files:**
- Modify: `backend/shared/endpoint.ts`
- Test: `test/unit/endpoint.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/endpoint.test.ts
import { afterEach, describe, expect, it } from "vitest"
import { Schema } from "effect"
import { endpointFilePath, EndpointFromJson, PROTOCOL_VERSION } from "@yodea/shared/endpoint"

const ORIGINAL = process.env.YODEA_ENDPOINT_FILE

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.YODEA_ENDPOINT_FILE
  else process.env.YODEA_ENDPOINT_FILE = ORIGINAL
})

describe("Endpoint", () => {
  it("roundtrips through JSON text", () => {
    const e = { url: "ws://127.0.0.1:51789/rpc", token: "abc", pid: 4242, protocolVersion: PROTOCOL_VERSION }
    const json = Schema.encodeSync(EndpointFromJson)(e)
    expect(Schema.decodeUnknownSync(EndpointFromJson)(json)).toEqual(e)
  })

  it("honors YODEA_ENDPOINT_FILE override", () => {
    process.env.YODEA_ENDPOINT_FILE = "/tmp/yodea-test/server.json"
    expect(endpointFilePath()).toBe("/tmp/yodea-test/server.json")
  })
})
```

- [ ] **Step 2: Run it — expect FAIL.** `bun run test -- test/unit/endpoint.test.ts`

- [ ] **Step 3: Implement `backend/shared/endpoint.ts`**

```ts
import { Schema } from "effect"
import { homedir } from "node:os"
import { join } from "node:path"

export const PROTOCOL_VERSION = 1

export const Endpoint = Schema.Struct({
  url: Schema.String,
  token: Schema.String,
  pid: Schema.Number,
  protocolVersion: Schema.Number
})
export type Endpoint = typeof Endpoint.Type

export const EndpointFromJson = Schema.fromJsonString(Endpoint)

// I-3: one well-known discovery file. YODEA_ENDPOINT_FILE (full path) and
// YODEA_HOME (parent dir) allow test/runtime isolation.
export const endpointFilePath = (): string =>
  process.env.YODEA_ENDPOINT_FILE ??
  join(process.env.YODEA_HOME ?? join(homedir(), ".yodea"), "server.json")
```

- [ ] **Step 4: Run it — expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add backend/shared/endpoint.ts test/unit/endpoint.test.ts
git commit -m "feat: add endpoint discovery schema and path resolution"
```

### Task 2.5: RPC contract group

**Agent:** tdd-implementer.

**Files:**
- Modify: `backend/shared/rpc.ts`
- Test: `test/unit/rpc-contract.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/rpc-contract.test.ts
import { describe, expect, it } from "vitest"
import { YodeaRpcs } from "@yodea/shared/rpc"

describe("YodeaRpcs contract", () => {
  it("is a defined RpcGroup", () => {
    expect(YodeaRpcs).toBeDefined()
  })
  it("exposes the five procedures by tag", () => {
    // RpcGroup exposes its requests; assert the tags we depend on exist.
    const tags = [...YodeaRpcs.requests.keys()]
    expect(tags).toEqual(
      expect.arrayContaining(["Health", "SessionCreate", "SessionList", "Connect", "Events"])
    )
  })
})
```

> **Verify against installed version:** `RpcGroup`'s introspection surface (`.requests`) is the one bit of `effect/unstable/rpc` most likely to differ. In `4.0.0-beta.74` `RpcGroup` exposes `readonly requests: ReadonlyMap<string, R>`, so `[...YodeaRpcs.requests.keys()]` yields the tags. If a later beta changes this shape and `.requests` is not a `Map`, replace Step-1's second assertion with `expect(Object.keys(YodeaRpcs)).toBeDefined()` and rely on the type-checker + Phase 5 server build to prove the group is wired. Do not delete the test — downgrade it.

- [ ] **Step 2: Run it — expect FAIL.** `bun run test -- test/unit/rpc-contract.test.ts`

- [ ] **Step 3: Implement `backend/shared/rpc.ts`**

```ts
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Schema } from "effect"
import { DomainEvent } from "@yodea/shared/events"
import { Session } from "@yodea/shared/session"

export class YodeaRpcs extends RpcGroup.make(
  // Liveness query.
  Rpc.make("Health", { success: Schema.String }),
  // Command: create a session, returns the created read-model.
  Rpc.make("SessionCreate", {
    payload: { title: Schema.String },
    success: Session
  }),
  // Query: list all sessions (projection).
  Rpc.make("SessionList", { success: Schema.Array(Session) }),
  // Presence channel (I-4): a frontend subscribes on connect and holds it for
  // the lifetime of its work. The server emits one `true` immediately so the
  // client can confirm the connection was registered, then keeps it open until
  // the socket drops.
  Rpc.make("Connect", { success: Schema.Boolean, stream: true }),
  // Live stream: every DomainEvent the backend commits (for read-model frontends).
  Rpc.make("Events", { success: DomainEvent, stream: true })
) {}
```

- [ ] **Step 4: Run it — expect PASS.** If `.requests` introspection differs, apply the downgrade note, then green.

- [ ] **Step 5: Commit**

```bash
git add backend/shared/rpc.ts test/unit/rpc-contract.test.ts
git commit -m "feat: add YodeaRpcs WebSocket contract"
```

**Phase 2 review gate:** dispatch `code-reviewer`. Confirm: all `backend/shared/**` modules import only Schema/node stdlib/`effect/unstable/rpc` (no domain/server imports), schemas roundtrip, and `bun run arch` is still green. Advance only on APPROVE.

---

## Phase 3 — Event-sourced storage + projection

**Outcome:** An append-only SQLite `EventStore` (the source of truth, WAL on disk) and a pure domain fold that rebuilds the `Session` read-model from the event log, wrapped in a `SessionProjection` service. Both are tested against an in-memory SQLite so they run fast and hermetically.

> **File-map refinement:** the `events` table DDL is created idempotently inside the `EventStore` layer (`CREATE TABLE IF NOT EXISTS`), not via a migrator. This is the research-recommended simplest-correct path for a single table. Introduce `SqliteMigrator` (and the `migrations/` dir from the map) at the first schema *change*. The map's `migrations/0001_create_events.ts` is therefore deferred, not built now.

### Task 3.1: EventStore service (append + readAll)

**Agent:** tdd-implementer.

**Files:**
- Modify: `backend/db/event-store.ts`
- Test: `test/integration/event-store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/integration/event-store.test.ts
import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EventStore, EventStoreLayer } from "@yodea/db/event-store"
import { SessionCreated } from "@yodea/shared/events"

// In-memory DB, WAL disabled (WAL is meaningless / noisy for :memory:).
const TestSql = SqliteClient.layer({ filename: ":memory:", disableWAL: true })
const TestStore = EventStoreLayer.pipe(Layer.provide(TestSql))

const run = <A, E>(eff: Effect.Effect<A, E, EventStore>) =>
  Effect.runPromise(Effect.provide(eff, TestStore))

describe("EventStore", () => {
  it("appends events and reads them back in insertion order", async () => {
    const events = await run(
      Effect.gen(function* () {
        const store = yield* EventStore
        yield* store.append(
          "s1",
          SessionCreated.make({ sessionId: "s1", title: "A", createdAt: "t1" })
        )
        yield* store.append(
          "s2",
          SessionCreated.make({ sessionId: "s2", title: "B", createdAt: "t2" })
        )
        return yield* store.readAll
      })
    )
    expect(events.map((e) => e.sessionId)).toEqual(["s1", "s2"])
    expect(events[0]._tag).toBe("SessionCreated")
  })

  it("returns an empty log initially", async () => {
    const events = await run(Effect.flatMap(EventStore, (s) => s.readAll))
    expect(events).toEqual([])
  })
})
```

- [ ] **Step 2: Run it — expect FAIL.** `bun run test -- test/integration/event-store.test.ts`

- [ ] **Step 3: Implement `backend/db/event-store.ts`**

```ts
import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { DomainEvent, DomainEventFromJson } from "@yodea/shared/events"

export class EventStore extends Context.Service<EventStore, {
  readonly append: (streamId: string, event: DomainEvent) => Effect.Effect<void>
  readonly readAll: Effect.Effect<ReadonlyArray<DomainEvent>>
}>()("yodea/EventStore", {
  // Requires SqlClient in context — provided by composition (file db) or tests (:memory:).
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    // Foundation schema: one append-only table. seq is the monotonic global order.
    yield* sql`
      CREATE TABLE IF NOT EXISTS events (
        seq        INTEGER PRIMARY KEY AUTOINCREMENT,
        stream_id  TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload    TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ) STRICT
    `
    yield* sql`CREATE INDEX IF NOT EXISTS idx_events_stream ON events (stream_id, seq)`

    const append = (streamId: string, event: DomainEvent) =>
      Effect.gen(function* () {
        const payload = yield* Schema.encodeEffect(DomainEventFromJson)(event)
        yield* sql`INSERT INTO events ${sql.insert({
          stream_id: streamId,
          event_type: event._tag,
          payload
        })}`
      })

    const readAll = Effect.gen(function* () {
      const rows = yield* sql<{ readonly payload: string }>`
        SELECT payload FROM events ORDER BY seq ASC
      `
      return yield* Effect.forEach(rows, (r) =>
        Schema.decodeUnknownEffect(DomainEventFromJson)(r.payload)
      )
    })

    return { append, readAll } as const
  })
}) {}

// v4 has no auto `.Default` layer — wire the layer from the stored `make` constructor.
export const EventStoreLayer = Layer.effect(EventStore, EventStore.make)
```

- [ ] **Step 4: Run it — expect PASS.** `bun run test -- test/integration/event-store.test.ts` → 2 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/db/event-store.ts test/integration/event-store.test.ts
git commit -m "feat: add event-sourced SQLite EventStore"
```

### Task 3.2: Pure session projection fold

**Agent:** tdd-implementer.

**Files:**
- Modify: `backend/domain/session.ts`
- Test: `test/unit/project-sessions.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/project-sessions.test.ts
import { describe, expect, it } from "vitest"
import { projectSessions } from "@yodea/domain/session"
import { SessionCreated } from "@yodea/shared/events"

describe("projectSessions", () => {
  it("folds an empty log into no sessions", () => {
    expect(projectSessions([])).toEqual([])
  })

  it("folds SessionCreated events into the read-model", () => {
    const sessions = projectSessions([
      SessionCreated.make({ sessionId: "s1", title: "A", createdAt: "t1" }),
      SessionCreated.make({ sessionId: "s2", title: "B", createdAt: "t2" })
    ])
    expect(sessions).toEqual([
      { id: "s1", title: "A", createdAt: "t1" },
      { id: "s2", title: "B", createdAt: "t2" }
    ])
  })
})
```

- [ ] **Step 2: Run it — expect FAIL.** `bun run test -- test/unit/project-sessions.test.ts`

- [ ] **Step 3: Implement `backend/domain/session.ts`**

```ts
import type { DomainEvent } from "@yodea/shared/events"
import type { Session } from "@yodea/shared/session"

// Pure left-fold of the event log into the Session read-model.
// No I/O — this is the deterministic core of the projection. As new event
// types join the DomainEvent union, add a `case` here.
export const projectSessions = (
  events: ReadonlyArray<DomainEvent>
): ReadonlyArray<Session> => {
  const byId = new Map<string, Session>()
  for (const event of events) {
    switch (event._tag) {
      case "SessionCreated":
        byId.set(event.sessionId, {
          id: event.sessionId,
          title: event.title,
          createdAt: event.createdAt
        })
        break
    }
  }
  return [...byId.values()]
}
```

- [ ] **Step 4: Run it — expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add backend/domain/session.ts test/unit/project-sessions.test.ts
git commit -m "feat: add pure session projection fold"
```

### Task 3.3: SessionProjection service

**Agent:** tdd-implementer.

**Files:**
- Modify: `backend/application/projections.ts`
- Test: `test/integration/projection.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/integration/projection.test.ts
import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EventStore, EventStoreLayer } from "@yodea/db/event-store"
import { SessionProjection, SessionProjectionLayer } from "@yodea/application/projections"
import { SessionCreated } from "@yodea/shared/events"

const TestSql = SqliteClient.layer({ filename: ":memory:", disableWAL: true })

// CRITICAL: provideMerge shares ONE EventStore instance with both the test's
// append calls and the projection. Providing EventStoreLayer twice would
// build two independent :memory: databases and the projection would see nothing.
const TestLayer = Layer.provideMerge(
  SessionProjectionLayer,
  EventStoreLayer
).pipe(Layer.provide(TestSql))

const run = <A, E>(eff: Effect.Effect<A, E, SessionProjection | EventStore>) =>
  Effect.runPromise(Effect.provide(eff, TestLayer))

describe("SessionProjection", () => {
  it("lists sessions rebuilt from the event log", async () => {
    const sessions = await run(
      Effect.gen(function* () {
        const store = yield* EventStore
        const projection = yield* SessionProjection
        yield* store.append(
          "s1",
          SessionCreated.make({ sessionId: "s1", title: "A", createdAt: "t1" })
        )
        return yield* projection.list
      })
    )
    expect(sessions).toEqual([{ id: "s1", title: "A", createdAt: "t1" }])
  })
})
```

- [ ] **Step 2: Run it — expect FAIL.** `bun run test -- test/integration/projection.test.ts`

- [ ] **Step 3: Implement `backend/application/projections.ts`**

```ts
import { Context, Effect, Layer } from "effect"
import type { Session } from "@yodea/shared/session"
import { EventStore } from "@yodea/db/event-store"
import { projectSessions } from "@yodea/domain/session"

export class SessionProjection extends Context.Service<SessionProjection, {
  readonly list: Effect.Effect<ReadonlyArray<Session>>
}>()("yodea/SessionProjection", {
  // Requires EventStore — provided once by composition (shared instance).
  make: Effect.gen(function* () {
    const store = yield* EventStore
    const list = Effect.map(store.readAll, projectSessions)
    return { list } as const
  })
}) {}

// v4 has no auto `.Default` layer — wire the layer from the stored `make` constructor.
export const SessionProjectionLayer = Layer.effect(SessionProjection, SessionProjection.make)
```

> Note: `list` is an `Effect` value (not a function) because it takes no arguments. The test and use-cases `yield*` it directly.

- [ ] **Step 4: Run it — expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add backend/application/projections.ts test/integration/projection.test.ts
git commit -m "feat: add SessionProjection service"
```

**Phase 3 review gate:** dispatch `code-reviewer`. Confirm: events are the source of truth (no separate state table), `readAll` orders by `seq`, the projection shares one `EventStore` (provideMerge), and payloads roundtrip through `DomainEventFromJson`. Advance only on APPROVE.

---

## Phase 4 — Event bus + use-cases (hexagonal core)

**Outcome:** The `EventBus` (in-memory `PubSub` broadcast) and the `UseCases` service that implements the commit path — append to the durable `EventStore`, then publish to the bus — plus the read query backed by the projection. This is the core the RPC layer will expose.

### Task 4.1: EventBus service

**Agent:** tdd-implementer.

**Files:**
- Modify: `backend/application/event-bus.ts`
- Test: `test/integration/event-bus.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/integration/event-bus.test.ts
import { describe, expect, it } from "vitest"
import { Effect, PubSub } from "effect"
import { EventBus, EventBusLayer } from "@yodea/application/event-bus"
import { SessionCreated } from "@yodea/shared/events"

describe("EventBus", () => {
  it("delivers events published after a subscription", async () => {
    const program = Effect.gen(function* () {
      const bus = yield* EventBus
      // Subscribe BEFORE publishing — PubSub only delivers to live subscribers.
      const sub = yield* bus.subscribe
      yield* bus.publish(
        SessionCreated.make({ sessionId: "s1", title: "A", createdAt: "t1" })
      )
      return yield* PubSub.take(sub)
    }).pipe(Effect.scoped, Effect.provide(EventBusLayer))

    const event = await Effect.runPromise(program)
    expect(event._tag).toBe("SessionCreated")
    expect(event.sessionId).toBe("s1")
  })
})
```

- [ ] **Step 2: Run it — expect FAIL.** `bun run test -- test/integration/event-bus.test.ts`

- [ ] **Step 3: Implement `backend/application/event-bus.ts`**

```ts
import { Context, Effect, Layer, PubSub, Scope, Stream } from "effect"
import type { DomainEvent } from "@yodea/shared/events"

export class EventBus extends Context.Service<EventBus, {
  readonly publish: (event: DomainEvent) => Effect.Effect<boolean>
  // Scoped Subscription — deterministic consumers/tests use this.
  readonly subscribe: Effect.Effect<PubSub.Subscription<DomainEvent>, never, Scope.Scope>
  // Stream view — the RPC `Events` handler returns this (new subscription per run).
  readonly stream: Stream.Stream<DomainEvent>
}>()("yodea/EventBus", {
  // `make`: the PubSub is a resource; it is shut down when the AppLayer scope closes.
  make: Effect.gen(function* () {
    const pubsub = yield* PubSub.unbounded<DomainEvent>()
    return {
      publish: (event: DomainEvent) => PubSub.publish(pubsub, event),
      // Scoped Subscription — consume with PubSub.take.
      subscribe: PubSub.subscribe(pubsub),
      // Stream view — Stream.fromPubSub self-subscribes (new subscription per run).
      stream: Stream.fromPubSub(pubsub)
    } as const
  })
}) {}

// v4 has no auto `.Default` layer — wire it manually with Layer.effect.
export const EventBusLayer = Layer.effect(EventBus, EventBus.make)
```

- [ ] **Step 4: Run it — expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add backend/application/event-bus.ts test/integration/event-bus.test.ts
git commit -m "feat: add EventBus (PubSub broadcast)"
```

### Task 4.2: UseCases service (commit path + queries)

**Agent:** tdd-implementer.

**Files:**
- Modify: `backend/application/use-cases.ts`
- Test: `test/integration/use-cases.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/integration/use-cases.test.ts
import { describe, expect, it } from "vitest"
import { Effect, Layer, PubSub } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EventStore, EventStoreLayer } from "@yodea/db/event-store"
import { EventBus, EventBusLayer } from "@yodea/application/event-bus"
import { SessionProjection, SessionProjectionLayer } from "@yodea/application/projections"
import { UseCases, UseCasesLayer } from "@yodea/application/use-cases"

const Sql = SqliteClient.layer({ filename: ":memory:", disableWAL: true })
// ONE shared EventStore (same constant referenced everywhere -> memoized to one instance).
const Store = EventStoreLayer.pipe(Layer.provide(Sql))
const Projection = SessionProjectionLayer.pipe(Layer.provide(Store))
// Output UseCases + EventStore + EventBus so the test can inspect all three.
const TestLayer = UseCasesLayer.pipe(
  Layer.provide(Projection),
  Layer.provideMerge(Store),
  Layer.provideMerge(EventBusLayer)
)

describe("UseCases.createSession", () => {
  it("appends a durable event, broadcasts it live, and reflects it in the projection", async () => {
    const program = Effect.gen(function* () {
      const useCases = yield* UseCases
      const bus = yield* EventBus
      const store = yield* EventStore

      const sub = yield* bus.subscribe // subscribe before the command (deterministic)
      const session = yield* useCases.createSession("Hello")

      const broadcast = yield* PubSub.take(sub)
      const persisted = yield* store.readAll
      const listed = yield* useCases.listSessions

      return { session, broadcast, persisted, listed }
    }).pipe(Effect.scoped, Effect.provide(TestLayer))

    const r = await Effect.runPromise(program)
    expect(r.session.title).toBe("Hello")
    expect(r.broadcast._tag).toBe("SessionCreated")
    expect(r.broadcast.sessionId).toBe(r.session.id) // same event broadcast as committed
    expect(r.persisted).toHaveLength(1)
    expect(r.listed).toEqual([r.session]) // read-your-writes
  })

  it("health returns ok", async () => {
    const ok = await Effect.runPromise(
      Effect.provide(Effect.flatMap(UseCases, (u) => u.health), TestLayer)
    )
    expect(ok).toBe("ok")
  })
})
```

- [ ] **Step 2: Run it — expect FAIL.** `bun run test -- test/integration/use-cases.test.ts`

- [ ] **Step 3: Implement `backend/application/use-cases.ts`**

```ts
import { Context, Effect, Layer } from "effect"
import { EventStore } from "@yodea/db/event-store"
import { EventBus } from "@yodea/application/event-bus"
import { SessionProjection } from "@yodea/application/projections"
import { SessionCreated } from "@yodea/shared/events"
import { newId } from "@yodea/lib/ids"

export class UseCases extends Context.Service<UseCases, {
  readonly health: Effect.Effect<string>
  readonly createSession: (
    title: string
  ) => Effect.Effect<{ id: string; title: string; createdAt: string }>
  readonly listSessions: Effect.Effect<ReadonlyArray<{ id: string; title: string; createdAt: string }>>
}>()("yodea/UseCases", {
  make: Effect.gen(function* () {
    const store = yield* EventStore
    const bus = yield* EventBus
    const projection = yield* SessionProjection

    const health = Effect.succeed("ok")

    // Commit path: durable append (source of truth) THEN live publish.
    // Append is the commit point; publish is best-effort live fan-out.
    const createSession = (title: string) =>
      Effect.gen(function* () {
        const id = newId()
        const createdAt = new Date().toISOString()
        const event = SessionCreated.make({ sessionId: id, title, createdAt })
        yield* store.append(id, event)
        yield* bus.publish(event)
        return { id, title, createdAt }
      })

    const listSessions = projection.list

    return { health, createSession, listSessions } as const
  })
}) {}

// v4 has no auto `.Default` layer — wire it manually with Layer.effect.
export const UseCasesLayer = Layer.effect(UseCases, UseCases.make)
```

- [ ] **Step 4: Run it — expect PASS.** `bun run test -- test/integration/use-cases.test.ts` → 2 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/application/use-cases.ts test/integration/use-cases.test.ts
git commit -m "feat: add UseCases with append-then-publish commit path"
```

**Phase 4 review gate:** dispatch `code-reviewer`. Confirm: the commit appends *before* publishing (durability first), the broadcast event is byte-identical to the committed event, `listSessions` reads through the projection (not a side table), and there is exactly one `EventStore` instance in the test wiring. Advance only on APPROVE.

---

## Phase 5 — Transport, lifetime (I-3, I-4), and composition

**Outcome:** The server-only modules: RPC handlers, the I-4 connection-tracker state machine, the I-3 endpoint-file resource, the WebSocket transport, and the `composition/app.ts` `runServer` that assembles the whole `AppLayer`.

> **I-4 realization decision (documented).** A "connection" is realized as an **active `Connect` subscription** — a dedicated presence channel, separate from the domain `Events` stream. Every frontend subscribes to `Connect` immediately on connect and holds it for the lifetime of its work (Phase 6 makes the CLI do this). The `Connect` handler runs `onConnect` when the subscription is established, **emits one `true` so the client can confirm registration before doing anything that might disconnect** (this closes a real race for fast one-shot commands), then stays open until the socket drops — at which point the stream's scope closes and `onDisconnect` runs. This avoids depending on transport-internal socket hooks (the most version-volatile area) and maps exactly onto I-4's guidance that "the calling process should keep its WebSocket connection open for the duration of its work." The deterministic counting logic is unit-tested (Task 5.2); the real socket-drop behavior is manual-tested (Phase 7). The domain `Events` stream carries no presence side effects.

### Task 5.1: RPC handlers

**Agent:** tdd-implementer. The contract conformance check here is the **type-checker**: `effect/unstable/rpc` enforces that every handler's payload/success/error matches `YodeaRpcs`. A mismatch fails `tsc`. (Runtime behavior is exercised end-to-end in Phase 7.)

**Files:**
- Modify: `backend/server/rpc-handlers.ts`

- [ ] **Step 1: Implement `backend/server/rpc-handlers.ts`**

```ts
import { Effect, Stream } from "effect"
import { YodeaRpcs } from "@yodea/shared/rpc"
import { UseCases } from "@yodea/application/use-cases"
import { EventBus } from "@yodea/application/event-bus"
import { ConnectionTracker } from "@yodea/server/connection-tracker"

export const YodeaHandlers = YodeaRpcs.toLayer({
  Health: () => Effect.flatMap(UseCases, (u) => u.health),
  SessionCreate: ({ title }) => Effect.flatMap(UseCases, (u) => u.createSession(title)),
  SessionList: () => Effect.flatMap(UseCases, (u) => u.listSessions),
  // Presence channel = the I-4 connection. onConnect when the subscription is
  // established; emit one `true` so the client can confirm before doing work;
  // onDisconnect (via finalizer) when the stream's scope closes on socket drop.
  // `Stream.never` keeps the subscription open after the marker. In v4 the
  // wrapped effect requires Scope, and `Stream.unwrap` discharges it.
  Connect: () =>
    Stream.unwrap(
      Effect.gen(function* () {
        const tracker = yield* ConnectionTracker
        yield* tracker.onConnect
        yield* Effect.addFinalizer(() => tracker.onDisconnect)
        return Stream.make(true).pipe(Stream.concat(Stream.never))
      })
    ),
  // Live domain-event stream (read-model frontends). No presence side effects.
  Events: () => Stream.unwrap(Effect.map(EventBus, (bus) => bus.stream))
})
```

> **Verify against installed version:** the handler-map shape (`YodeaRpcs.toLayer({...})`, payload destructured as the first arg, `() =>` for no-payload procedures) is the `effect/unstable/rpc` idiom (`RpcGroup.toLayer` is an instance method on the group). `Stream.unwrap` replaces the 3.x `Stream.unwrapScoped` — it strips the inner effect's `Scope.Scope` requirement, so the scoped `addFinalizer` still runs `onDisconnect` when the subscription's scope closes. If `toLayer` is named differently or expects different handler shapes in your installed beta, adapt the wiring — the handler bodies (what each returns) stay identical.

- [ ] **Step 2: Type-check — the contract conformance gate**

Run: `bunx tsc --noEmit`
Expected: exits 0. (If a handler returned the wrong type — e.g. `SessionList` returning a single `Session` — this is where it fails.)

- [ ] **Step 3: Commit**

```bash
git add backend/server/rpc-handlers.ts
git commit -m "feat: add RPC handlers mapping the contract to use-cases"
```

### Task 5.2: ConnectionTracker — the I-4 state machine

**Agent:** tdd-implementer.

**Files:**
- Modify: `backend/server/connection-tracker.ts`
- Test: `test/unit/connection-tracker.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/connection-tracker.test.ts
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { ConnectionTracker, ConnectionTrackerLayer } from "@yodea/server/connection-tracker"

const run = <A, E>(eff: Effect.Effect<A, E, ConnectionTracker>) =>
  Effect.runPromise(Effect.provide(Effect.scoped(eff), ConnectionTrackerLayer))

describe("ConnectionTracker (I-4)", () => {
  it("is not armed before the first connect, and arms then fires exactly at zero", async () => {
    const states = await run(
      Effect.gen(function* () {
        const t = yield* ConnectionTracker
        const s0 = yield* t.isShuttingDown // false: nothing happened
        yield* t.onDisconnect // disconnect before any connect: not armed
        const s1 = yield* t.isShuttingDown // false: still not armed
        yield* t.onConnect // count 0->1, ARMED
        yield* t.onConnect // count 1->2
        yield* t.onDisconnect // count 2->1
        const s2 = yield* t.isShuttingDown // false: one still connected
        yield* t.onDisconnect // count 1->0, armed -> FIRE
        const s3 = yield* t.isShuttingDown // true
        return { s0, s1, s2, s3 }
      })
    )
    expect(states).toEqual({ s0: false, s1: false, s2: false, s3: true })
  })

  it("never lets the count go negative", async () => {
    const n = await run(
      Effect.gen(function* () {
        const t = yield* ConnectionTracker
        yield* t.onDisconnect
        yield* t.onDisconnect
        return yield* t.count
      })
    )
    expect(n).toBe(0)
  })
})
```

- [ ] **Step 2: Run it — expect FAIL.** `bun run test -- test/unit/connection-tracker.test.ts`

- [ ] **Step 3: Implement `backend/server/connection-tracker.ts`**

```ts
import { Context, Deferred, Effect, Layer, Ref } from "effect"

export class ConnectionTracker extends Context.Service<ConnectionTracker, {
  readonly onConnect: Effect.Effect<void>
  readonly onDisconnect: Effect.Effect<void>
  readonly awaitShutdown: Effect.Effect<void>
  readonly isShuttingDown: Effect.Effect<boolean>
  readonly count: Effect.Effect<number>
}>()("yodea/ConnectionTracker", {
  make: Effect.gen(function* () {
    const count = yield* Ref.make(0)
    const armed = yield* Ref.make(false)
    const shutdown = yield* Deferred.make<void>()

    const onConnect = Effect.andThen(
      Ref.update(count, (n) => n + 1),
      Ref.set(armed, true)
    )

    const onDisconnect = Effect.gen(function* () {
      const n = yield* Ref.updateAndGet(count, (c) => Math.max(0, c - 1))
      const isArmed = yield* Ref.get(armed)
      if (isArmed && n === 0) {
        yield* Deferred.succeed(shutdown, undefined)
      }
    })

    return {
      onConnect,
      onDisconnect,
      // Composition blocks on this; resolves once armed && count returns to 0.
      awaitShutdown: Deferred.await(shutdown),
      isShuttingDown: Deferred.isDone(shutdown),
      count: Ref.get(count)
    } as const
  })
}) {}

// v4 has no auto `.Default` layer — wire it manually from the stored `make`.
export const ConnectionTrackerLayer = Layer.effect(ConnectionTracker, ConnectionTracker.make)
```

- [ ] **Step 4: Run it — expect PASS.** `bun run test -- test/unit/connection-tracker.test.ts` → 2 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/server/connection-tracker.ts test/unit/connection-tracker.test.ts
git commit -m "feat: add I-4 connection-tracker state machine"
```

### Task 5.3: Endpoint file resource (I-3)

**Agent:** tdd-implementer.

**Files:**
- Modify: `backend/server/endpoint-file.ts`
- Test: `test/integration/endpoint-file.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/integration/endpoint-file.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Effect, Exit, FileSystem, Scope } from "effect"
import { BunServices } from "@effect/platform-bun"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeEndpointFile } from "@yodea/server/endpoint-file"
import { endpointFilePath, PROTOCOL_VERSION } from "@yodea/shared/endpoint"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yodea-ep-"))
  process.env.YODEA_ENDPOINT_FILE = join(dir, "server.json")
})
afterEach(() => {
  delete process.env.YODEA_ENDPOINT_FILE
  rmSync(dir, { recursive: true, force: true })
})

describe("endpoint file (I-3)", () => {
  it("writes the file inside the scope and removes it when the scope closes", async () => {
    const file = endpointFilePath()
    const program = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const scope = yield* Scope.make()
      yield* Effect.provideService(
        writeEndpointFile({
          url: "ws://127.0.0.1:51789/rpc",
          token: "tok",
          pid: 4242,
          protocolVersion: PROTOCOL_VERSION
        }),
        Scope.Scope,
        scope
      )
      const during = yield* fs.exists(file)
      yield* Scope.close(scope, Exit.void)
      const after = yield* fs.exists(file)
      return { during, after }
    }).pipe(Effect.provide(BunServices.layer))

    const r = await Effect.runPromise(program)
    expect(r.during).toBe(true)
    expect(r.after).toBe(false)
  })
})
```

- [ ] **Step 2: Run it — expect FAIL.** `bun run test -- test/integration/endpoint-file.test.ts`

- [ ] **Step 3: Implement `backend/server/endpoint-file.ts`**

```ts
import { Effect, FileSystem, Path, Schema } from "effect"
import { Endpoint, EndpointFromJson, endpointFilePath } from "@yodea/shared/endpoint"

// I-3: write server.json on acquire, remove it on scope close (clean shutdown).
export const writeEndpointFile = (endpoint: Endpoint) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const file = endpointFilePath()
      yield* fs.makeDirectory(path.dirname(file), { recursive: true })
      const json = yield* Schema.encodeEffect(EndpointFromJson)(endpoint)
      yield* fs.writeFileString(file, json)
      return file
    }),
    (file) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* fs.remove(file)
      }).pipe(Effect.ignore) // cleanup is best-effort; the file may already be gone
  )
```

- [ ] **Step 4: Run it — expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add backend/server/endpoint-file.ts test/integration/endpoint-file.test.ts
git commit -m "feat: add I-3 endpoint file resource"
```

### Task 5.4: WebSocket transport layer

**Agent:** tdd-implementer. Verified by `tsc` (the transport wiring is type-level); its runtime behavior is proven in Phase 7.

**Files:**
- Modify: `backend/server/http.ts`

- [ ] **Step 1: Implement `backend/server/http.ts`**

```ts
import { Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { BunHttpServer } from "@effect/platform-bun"
import { YodeaRpcs } from "@yodea/shared/rpc"
import { YodeaHandlers } from "@yodea/server/rpc-handlers"

// Serves YodeaRpcs over WebSocket (NDJSON) at /rpc. The handler dependencies
// (UseCases | EventBus | ConnectionTracker) bubble up as requirements for
// composition to provide.
export const httpServerLayer = (port: number) => {
  const rpc = RpcServer.layer(YodeaRpcs).pipe(Layer.provide(YodeaHandlers))
  const protocol = RpcServer.layerProtocolWebsocket({ path: "/rpc" }).pipe(
    Layer.provide(RpcSerialization.layerNdjson)
  )
  return HttpRouter.serve(rpc).pipe(
    Layer.provide(protocol),
    Layer.provide(BunHttpServer.layer({ port }))
  )
}
```

> **Verify against installed version (transport — the #1 volatility point):** confirm `RpcServer.layer`, `RpcServer.layerProtocolWebsocket({ path })`, `RpcSerialization.layerNdjson`, and that `HttpRouter.serve(appLayer)` is the correct host for the WS upgrade under `BunHttpServer.layer({ port })`. In v4 `HttpRouter.serve` takes the app **layer** directly (there is no `HttpRouter.Default.serve()`); the RPC runner layer is passed as that arg, with the protocol + serialization layers provided into it. Note the lowercase `s` in `layerProtocolWebsocket`. If `layerProtocolWebsocket` moved or renamed, the bodies stay; only the layer names change.

- [ ] **Step 2: Type-check.** Run: `bunx tsc --noEmit` → exits 0.

- [ ] **Step 3: Commit**

```bash
git add backend/server/http.ts
git commit -m "feat: add WebSocket RPC transport layer"
```

### Task 5.5: Composition — `runServer` (the one and only AppLayer)

**Agent:** tdd-implementer. This is the single place the `AppLayer` is constructed (I-2). Verified by `tsc`; full runtime behavior is proven in Phase 7. **Do not** call `runServer` from a vitest test — it binds a port and blocks until shutdown.

**Files:**
- Modify: `backend/composition/app.ts`

- [ ] **Step 1: Implement `backend/composition/app.ts`**

```ts
import { Effect, Layer } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { BunServices } from "@effect/platform-bun"
import { EventStore, EventStoreLayer } from "@yodea/db/event-store"
import { EventBus, EventBusLayer } from "@yodea/application/event-bus"
import { SessionProjectionLayer } from "@yodea/application/projections"
import { UseCasesLayer } from "@yodea/application/use-cases"
import { ConnectionTracker, ConnectionTrackerLayer } from "@yodea/server/connection-tracker"
import { httpServerLayer } from "@yodea/server/http"
import { writeEndpointFile } from "@yodea/server/endpoint-file"
import { PROTOCOL_VERSION } from "@yodea/shared/endpoint"
import { newId } from "@yodea/lib/ids"

export interface RunServerOptions {
  readonly dbPath: string
  readonly port: number
}

// Domain + application services as ONE shared graph. Each `XLayer` is a stable
// memoized layer, so referencing `store` in three places yields ONE EventStore
// instance (and thus one SQLite handle, one PubSub, one tracker). v4 has no
// auto `.Default` — every service exports its layer explicitly (`Layer.effect`).
const coreLayer = (dbPath: string) => {
  const sql = SqliteClient.layer({ filename: dbPath })
  const store = EventStoreLayer.pipe(Layer.provide(sql))
  const projection = SessionProjectionLayer.pipe(Layer.provide(store))
  const useCases = UseCasesLayer.pipe(
    Layer.provide(store),
    Layer.provide(EventBusLayer),
    Layer.provide(projection)
  )
  // The RPC handlers depend on exactly these three.
  return Layer.mergeAll(useCases, EventBusLayer, ConnectionTrackerLayer)
}

export const runServer = (options: RunServerOptions) => {
  const core = coreLayer(options.dbPath)
  const url = `ws://127.0.0.1:${options.port}/rpc`

  const program = Effect.gen(function* () {
    const tracker = yield* ConnectionTracker
    // I-3: advertise the endpoint (acquireRelease removes it on scope close).
    yield* writeEndpointFile({
      url,
      token: newId(),
      pid: process.pid,
      protocolVersion: PROTOCOL_VERSION
    })
    yield* Effect.logInfo(`yodea backend listening on ${url} (pid ${process.pid})`)
    // I-4: block until armed && connection count returns to zero.
    yield* tracker.awaitShutdown
    yield* Effect.logInfo("last connection closed — shutting down")
  })

  // `core` is shared between the transport (handlers) and the program (tracker),
  // so the count the handlers mutate is the count the program awaits.
  return program.pipe(
    Effect.provide(
      Layer.mergeAll(
        httpServerLayer(options.port).pipe(Layer.provide(core)),
        core,
        BunServices.layer
      )
    ),
    Effect.scoped
  )
}
```

> **Why `Effect.scoped` + `awaitShutdown` instead of `Layer.launch`:** the server must perform imperative lifecycle steps (advertise endpoint, then wait for the zero-connection signal) that depend on the running `AppLayer`. Wrapping the orchestration program in the provided layers and `Effect.scoped` guarantees that when `awaitShutdown` resolves (or the fiber is interrupted by SIGINT/SIGTERM via `BunRuntime.runMain`), the scope closes in reverse order: endpoint file removed → server stopped → SQLite closed. If a long-lived supervisory fiber is ever needed here, use `Effect.forkScoped` (3.x `Effect.fork` is gone in v4) so the fiber is bound to this scope and interrupted on shutdown.

- [ ] **Step 2: Type-check.** Run: `bunx tsc --noEmit` → exits 0.

- [ ] **Step 3: Commit**

```bash
git add backend/composition/app.ts
git commit -m "feat: add runServer composition (single AppLayer, I-2/I-3/I-4)"
```

**Phase 5 review gate:** dispatch `code-reviewer`. Confirm: (a) `coreLayer` shares one `EventStore`/`ConnectionTracker` (the `core` const is reused, not rebuilt; the memoized `XLayer`s are referenced, not rebuilt), (b) the endpoint file is written *after* the server layer is in the environment (advertise only once listening), (c) `runServer` is the *only* place an `AppLayer` is assembled (grep: no other module imports `SqliteClient.layer` outside tests), (d) `bun run arch` still green. Advance only on APPROVE.

---

## Phase 6 — CLI thin client (I-1)

**Outcome:** The `backend/cli/**` modules: endpoint discovery + find-or-spawn, the RPC client (which opens the `Events` subscription = its I-4 connection), the `effect/unstable/cli` commands, and `main.ts`. Every file here imports only `backend/shared/**`, `backend/lib/**`, or npm — except `commands/server.ts`, which is the sanctioned I-1 exception. The I-1 fitness test from Phase 1 stays green throughout.

### Task 6.1: Endpoint discovery (read + validate)

**Agent:** tdd-implementer.

**Files:**
- Modify: `backend/cli/discovery.ts`
- Test: `test/integration/discovery.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/integration/discovery.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Effect, Option } from "effect"
import { BunServices } from "@effect/platform-bun"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readEndpoint } from "@yodea/cli/discovery"
import { endpointFilePath, PROTOCOL_VERSION } from "@yodea/shared/endpoint"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yodea-disc-"))
  process.env.YODEA_ENDPOINT_FILE = join(dir, "server.json")
})
afterEach(() => {
  delete process.env.YODEA_ENDPOINT_FILE
  rmSync(dir, { recursive: true, force: true })
})

const run = <A, E>(eff: Effect.Effect<A, E, any>) =>
  Effect.runPromise(Effect.provide(eff, BunServices.layer))

const writeEndpoint = (pid: number, protocolVersion = PROTOCOL_VERSION) =>
  writeFileSync(
    endpointFilePath(),
    JSON.stringify({ url: "ws://127.0.0.1:51789/rpc", token: "t", pid, protocolVersion })
  )

describe("readEndpoint", () => {
  it("returns None when the file is missing", async () => {
    expect(Option.isNone(await run(readEndpoint))).toBe(true)
  })
  it("returns Some for a live pid", async () => {
    writeEndpoint(process.pid) // self -> alive
    const r = await run(readEndpoint)
    expect(Option.isSome(r)).toBe(true)
  })
  it("returns None for a dead pid (stale file)", async () => {
    writeEndpoint(2147483647) // out-of-range pid -> ESRCH -> treated as dead
    expect(Option.isNone(await run(readEndpoint))).toBe(true)
  })
  it("returns None for a protocol-version mismatch", async () => {
    writeEndpoint(process.pid, PROTOCOL_VERSION + 1)
    expect(Option.isNone(await run(readEndpoint))).toBe(true)
  })
  it("returns None for malformed JSON", async () => {
    writeFileSync(endpointFilePath(), "{ not json")
    expect(Option.isNone(await run(readEndpoint))).toBe(true)
  })
})
```

- [ ] **Step 2: Run it — expect FAIL.** `bun run test -- test/integration/discovery.test.ts`

- [ ] **Step 3: Implement `backend/cli/discovery.ts`** (imports only shared + platform npm — I-1 safe)

```ts
import { Data, Effect, FileSystem, Option, Schema } from "effect"
import { Endpoint, EndpointFromJson, endpointFilePath, PROTOCOL_VERSION } from "@yodea/shared/endpoint"

export class BackendUnavailable extends Data.TaggedError("BackendUnavailable")<{
  readonly reason: string
}> {}

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0) // signal 0 = liveness probe, doesn't actually signal
    return true
  } catch {
    return false
  }
}

// Read + validate the discovery file. None if missing, malformed, wrong
// protocol, or owned by a dead pid (stale).
export const readEndpoint: Effect.Effect<Option.Option<Endpoint>, never, FileSystem.FileSystem> =
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const file = endpointFilePath()
    if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))) {
      return Option.none()
    }
    const text = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))
    const decoded = yield* Schema.decodeUnknownEffect(EndpointFromJson)(text).pipe(Effect.option)
    if (Option.isNone(decoded)) return Option.none()
    const endpoint = decoded.value
    if (endpoint.protocolVersion !== PROTOCOL_VERSION) return Option.none()
    if (!isProcessAlive(endpoint.pid)) return Option.none()
    return Option.some(endpoint)
  })
```

- [ ] **Step 4: Run it — expect PASS.** `bun run test -- test/integration/discovery.test.ts` → 5 passed.

- [ ] **Step 5: Verify I-1 still holds.** Run: `bun run arch` → exit 0.

- [ ] **Step 6: Commit**

```bash
git add backend/cli/discovery.ts test/integration/discovery.test.ts
git commit -m "feat: add CLI endpoint discovery with staleness checks"
```

### Task 6.2: Find-or-spawn the backend (under exclusive lock)

**Agent:** tdd-implementer.

**Files:**
- Modify: `backend/cli/discovery.ts`
- Test: `test/integration/find-or-spawn.test.ts`

- [ ] **Step 1: Write the failing test** (covers the short-circuit branch; the real spawn is manual-tested in Phase 7)

```ts
// test/integration/find-or-spawn.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Effect } from "effect"
import { BunServices } from "@effect/platform-bun"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findOrSpawnBackend } from "@yodea/cli/discovery"
import { endpointFilePath, PROTOCOL_VERSION } from "@yodea/shared/endpoint"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yodea-spawn-"))
  process.env.YODEA_ENDPOINT_FILE = join(dir, "server.json")
})
afterEach(() => {
  delete process.env.YODEA_ENDPOINT_FILE
  rmSync(dir, { recursive: true, force: true })
})

describe("findOrSpawnBackend", () => {
  it("returns the existing live backend without spawning", async () => {
    writeFileSync(
      endpointFilePath(),
      JSON.stringify({
        url: "ws://127.0.0.1:51789/rpc",
        token: "t",
        pid: process.pid,
        protocolVersion: PROTOCOL_VERSION
      })
    )
    const endpoint = await Effect.runPromise(
      Effect.provide(findOrSpawnBackend({ port: 51789 }), BunServices.layer)
    )
    expect(endpoint.url).toBe("ws://127.0.0.1:51789/rpc")
    expect(endpoint.pid).toBe(process.pid)
  })
})
```

- [ ] **Step 2: Run it — expect FAIL.** `bun run test -- test/integration/find-or-spawn.test.ts`

- [ ] **Step 3: Extend `backend/cli/discovery.ts`** (append; still I-1 safe)

```ts
import { Schedule } from "effect"
import { openSync, closeSync, rmSync } from "node:fs"
import { dirname } from "node:path"

export interface SpawnOptions {
  readonly port: number
}

// Spawn `yodea server` as a detached background process. Targets the COMPILED
// binary (process.execPath === dist/yodea), which is the shipped artifact.
const spawnServer = Effect.sync(() => {
  const child = Bun.spawn({
    cmd: [process.execPath, "server"],
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
    env: process.env
  })
  child.unref()
})

const lockPath = () => `${endpointFilePath()}.lock`

// Best-effort exclusive spawn lock (O_EXCL). Returns true if WE acquired it.
const tryAcquireLock = Effect.sync(() => {
  try {
    // "wx" => create + fail if exists. Directory is ensured by the server, but
    // for the spawn race we create it here too.
    Bun.spawnSync({ cmd: ["mkdir", "-p", dirname(lockPath())] })
    const fd = openSync(lockPath(), "wx")
    closeSync(fd)
    return true
  } catch {
    return false
  }
})
const releaseLock = Effect.sync(() => {
  try {
    rmSync(lockPath(), { force: true })
  } catch {}
})

// Poll the discovery file until a live endpoint appears or we time out.
const awaitEndpoint = readEndpoint.pipe(
  Effect.flatMap((o) =>
    Option.isSome(o) ? Effect.succeed(o.value) : Effect.fail("pending" as const)
  ),
  Effect.retry(Schedule.spaced("50 millis")),
  Effect.timeoutOrElse({
    duration: "5 seconds",
    orElse: () => Effect.fail(new BackendUnavailable({ reason: "backend did not start in time" }))
  })
)

// I-2/I-4 step 1: find a running backend or spawn exactly one.
export const findOrSpawnBackend = (options: SpawnOptions) =>
  Effect.gen(function* () {
    const existing = yield* readEndpoint
    if (Option.isSome(existing)) return existing.value

    const acquired = yield* tryAcquireLock
    if (!acquired) {
      // Another CLI is spawning — don't spawn a second server; just wait.
      return yield* awaitEndpoint
    }
    return yield* spawnServer.pipe(
      Effect.andThen(awaitEndpoint),
      Effect.ensuring(releaseLock)
    )
  })
```

> Note `options.port` is currently informational (the spawned server uses its own default port; see `commands/server.ts`). It is threaded now so the signature is stable when ephemeral-port negotiation is added.

- [ ] **Step 4: Run it — expect PASS.**

- [ ] **Step 5: Verify I-1.** `bun run arch` → exit 0.

- [ ] **Step 6: Commit**

```bash
git add backend/cli/discovery.ts test/integration/find-or-spawn.test.ts
git commit -m "feat: add find-or-spawn backend with exclusive spawn lock"
```

### Task 6.3: RPC client + presence-held connection

**Agent:** tdd-implementer. Verified by `tsc` + I-1; the full runtime path is exercised by the in-process e2e in Phase 7.

**Files:**
- Modify: `backend/cli/rpc-client.ts`

- [ ] **Step 1: Implement `backend/cli/rpc-client.ts`** (imports shared + npm + the cli `discovery` module — all I-1 safe)

```ts
import { RpcClient, RpcSerialization } from "effect/unstable/rpc"
import { Deferred, Effect, Layer, Stream } from "effect"
import { BunSocket } from "@effect/platform-bun"
import { YodeaRpcs } from "@yodea/shared/rpc"
import { findOrSpawnBackend, type SpawnOptions } from "@yodea/cli/discovery"

// WebSocket RPC transport for a known backend URL. NDJSON must match the server.
// BunSocket.layerWebSocket bundles the WebSocket constructor (Bun-native), so no
// separate WebSocketConstructor layer is needed.
const protocolLayer = (url: string) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provide(BunSocket.layerWebSocket(url))
  )

// Discover-or-spawn the backend, connect, establish the I-4 presence channel,
// wait until the server registered us, run `use`, then tear everything down
// (dropping presence -> server may shut down if we were the last connection).
export const withClient = <A, E, R>(
  options: SpawnOptions,
  use: (client: RpcClient.RpcClient<YodeaRpcs>) => Effect.Effect<A, E, R>
) =>
  findOrSpawnBackend(options).pipe(
    Effect.flatMap((endpoint) =>
      Effect.gen(function* () {
        const client = yield* RpcClient.make(YodeaRpcs)
        const ready = yield* Deferred.make<void>()
        // Hold the presence subscription for the whole scope; resolve `ready`
        // on the first `true` so we never disconnect before being registered.
        yield* Effect.forkScoped(
          Stream.runDrain(
            Stream.tap(client.Connect(), () => Deferred.succeed(ready, undefined))
          )
        )
        yield* Deferred.await(ready)
        return yield* use(client)
      }).pipe(Effect.scoped, Effect.provide(protocolLayer(endpoint.url)))
    )
  )
```

> **Verify against installed version (client transport — volatility point #1, and the client *type name* #2):** (a) confirm `RpcClient.make`, `RpcClient.layerProtocolSocket`, `BunSocket.layerWebSocket`, `RpcSerialization.layerNdjson` per the research. `BunSocket.layerWebSocket(url)` is `Layer<Socket, never, never>` and bundles the WebSocket constructor itself — do NOT add `Socket.layerWebSocketConstructorGlobal`. (b) If `RpcClient.RpcClient<YodeaRpcs>` is not the exact client type (note `RpcClient.make` resolves the client with the `RpcClientError` union on each method's error channel — i.e. `RpcClient.RpcClient<YodeaRpcs, RpcClientError>`), let inference carry it — e.g. type `use`'s parameter via `Effect.Effect.Success<ReturnType<typeof RpcClient.make<typeof YodeaRpcs>>>`, or inline the client usage in each command instead of this helper. The runtime body stays identical.

- [ ] **Step 2: Type-check + I-1.** Run: `bunx tsc --noEmit` → 0; `bun run arch` → 0.

- [ ] **Step 3: Commit**

```bash
git add backend/cli/rpc-client.ts
git commit -m "feat: add CLI RPC client with held presence connection"
```

### Task 6.4: `health` and `session` commands

**Agent:** tdd-implementer. Verified by `tsc` + I-1; runtime in Phase 7.

**Files:**
- Modify: `backend/cli/commands/health.ts`
- Modify: `backend/cli/commands/session.ts`

- [ ] **Step 1: Implement `backend/cli/commands/health.ts`**

```ts
import { Command, Flag } from "effect/unstable/cli"
import { Console, Effect } from "effect"
import { withClient } from "@yodea/cli/rpc-client"

const json = Flag.boolean("json").pipe(Flag.withDefault(false))

export const healthCommand = Command.make("health", { json }, ({ json }) =>
  withClient({ port: 51789 }, (client) =>
    Effect.flatMap(client.Health(), (status) =>
      Console.log(json ? JSON.stringify({ status }) : status)
    )
  )
)
```

- [ ] **Step 2: Implement `backend/cli/commands/session.ts`**

```ts
import { Argument, Command, Flag } from "effect/unstable/cli"
import { Console, Effect } from "effect"
import { withClient } from "@yodea/cli/rpc-client"

const json = Flag.boolean("json").pipe(Flag.withDefault(false))
const title = Argument.string("title")

const create = Command.make("create", { title, json }, ({ title, json }) =>
  withClient({ port: 51789 }, (client) =>
    Effect.flatMap(client.SessionCreate({ title }), (session) =>
      Console.log(json ? JSON.stringify(session) : `created ${session.id}  ${session.title}`)
    )
  )
)

const ls = Command.make("ls", { json }, ({ json }) =>
  withClient({ port: 51789 }, (client) =>
    Effect.flatMap(client.SessionList(), (sessions) =>
      json
        ? Console.log(JSON.stringify(sessions))
        : Effect.forEach(sessions, (s) => Console.log(`${s.id}  ${s.title}`), {
            discard: true
          })
    )
  )
)

export const sessionCommand = Command.make("session", {}, () =>
  Console.log("usage: yodea session <create|ls>")
).pipe(Command.withSubcommands([create, ls]))
```

- [ ] **Step 3: Type-check + I-1.** `bunx tsc --noEmit` → 0; `bun run arch` → 0.

- [ ] **Step 4: Commit**

```bash
git add backend/cli/commands/health.ts backend/cli/commands/session.ts
git commit -m "feat: add health and session CLI commands"
```

### Task 6.5: `server` subcommand (the I-1 exception) + entrypoint

**Agent:** tdd-implementer. `commands/server.ts` is the **only** CLI file permitted to import `backend/composition/**`. Keep it minimal.

**Files:**
- Modify: `backend/cli/commands/server.ts`
- Modify: `backend/cli/main.ts`

- [ ] **Step 1: Implement `backend/cli/commands/server.ts`**

```ts
import { Command } from "effect/unstable/cli"
import { homedir } from "node:os"
import { join } from "node:path"
import { runServer } from "@yodea/composition/app" // I-1 permitted exception (this file only)

const dbPath = () =>
  process.env.YODEA_DB ??
  join(process.env.YODEA_HOME ?? join(homedir(), ".yodea"), "events.db")

export const serverCommand = Command.make("server", {}, () =>
  runServer({ dbPath: dbPath(), port: 51789 })
)
```

- [ ] **Step 2: Implement `backend/cli/main.ts`**

```ts
import { Command } from "effect/unstable/cli"
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console } from "effect"
import { healthCommand } from "@yodea/cli/commands/health"
import { sessionCommand } from "@yodea/cli/commands/session"
import { serverCommand } from "@yodea/cli/commands/server"

const yodea = Command.make("yodea", {}, () =>
  Console.log("yodea — run `yodea --help`")
).pipe(Command.withSubcommands([serverCommand, healthCommand, sessionCommand]))

// Command.run reads argv from Stdio itself — do NOT pass process.argv.
Command.run(yodea, { version: "0.0.0" }).pipe(
  Effect.provide(BunServices.layer),
  BunRuntime.runMain
)
```

> Add `Effect` to the imports (`import { Console, Effect } from "effect"`) — it is used for `Effect.provide`.

- [ ] **Step 3: Type-check + the I-1 acid test.**

Run: `bunx tsc --noEmit` → 0
Run: `bun run arch` → 0 — **this is the moment of truth for I-1**: `main.ts` imports the `server` command, but only `commands/server.ts` reaches into `composition/`; the cruiser must still pass.

- [ ] **Step 4: Smoke-run the CLI parser (no backend needed)**

Run: `bun backend/cli/main.ts --help`
Expected: prints usage listing `server`, `health`, `session`. (This exercises `effect/unstable/cli` wiring without connecting.)

- [ ] **Step 5: Commit**

```bash
git add backend/cli/commands/server.ts backend/cli/main.ts
git commit -m "feat: wire yodea CLI entrypoint with server/health/session"
```

**Phase 6 review gate:** dispatch `code-reviewer`. Confirm: (a) `bun run arch` is green with `commands/server.ts` importing `composition/` and nothing else in `cli/` doing so, (b) `main.ts` does not import `composition/` directly, (c) the client holds the `Connect` subscription for the command's lifetime and waits for the readiness marker. Advance only on APPROVE.

---

## Phase 7 — End-to-end verification (the slice proves itself)

**Outcome:** One in-process automated e2e test that boots the real server, drives it over a real loopback WebSocket through the CLI's own client, and proves I-3/I-4; plus a `manual-tester` pass over the **compiled binary** that proves auto-spawn, zero-connection shutdown, and — the payoff of event sourcing — that sessions survive a server restart. After this phase the walking skeleton is complete: every architectural seam exercised, every invariant enforced.

> **Test isolation note:** tests that bind a port (this phase) must use a unique port and should run serially. If your vitest runs files in parallel workers, give this file a dedicated port (below uses `51990`) and/or mark it with `describe.sequential`.

### Task 7.1: In-process end-to-end lifecycle test

**Agent:** tdd-implementer.

**Files:**
- Test: `test/integration/e2e-lifecycle.test.ts`

- [ ] **Step 1: Write the test** (this is the automated proof of the whole stack)

```ts
// test/integration/e2e-lifecycle.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Effect, Fiber, FileSystem, Option, Schedule, Stream } from "effect"
import { BunServices } from "@effect/platform-bun"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runServer } from "@yodea/composition/app"
import { withClient } from "@yodea/cli/rpc-client"
import { readEndpoint } from "@yodea/cli/discovery"
import { endpointFilePath } from "@yodea/shared/endpoint"

const PORT = 51990
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yodea-e2e-"))
  process.env.YODEA_ENDPOINT_FILE = join(dir, "server.json")
})
afterEach(() => {
  delete process.env.YODEA_ENDPOINT_FILE
  rmSync(dir, { recursive: true, force: true })
})

const awaitEndpointUp = readEndpoint.pipe(
  Effect.flatMap((o) => (Option.isSome(o) ? Effect.void : Effect.fail("pending" as const))),
  Effect.retry(Schedule.spaced("25 millis")),
  Effect.timeoutOrElse({
    duration: "5 seconds",
    orElse: () => Effect.fail(new Error("server never advertised an endpoint (I-3)"))
  })
)

describe.sequential("end-to-end lifecycle", () => {
  it("boots, serves RPCs over WebSocket, and shuts down when the last client leaves", async () => {
    const program = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dbPath = join(dir, "events.db")
      const serverFiber = yield* Effect.forkChild(runServer({ dbPath, port: PORT }))

      yield* awaitEndpointUp
      const upDuring = yield* fs.exists(endpointFilePath())

      const outcome = yield* withClient({ port: PORT }, (client) =>
        Effect.gen(function* () {
          const health = yield* client.Health()
          const created = yield* client.SessionCreate({ title: "E2E" })
          const listed = yield* client.SessionList()
          return { health, created, listed }
        })
      )

      // Last client gone -> the server must shut itself down (I-4).
      yield* Fiber.join(serverFiber).pipe(
        Effect.timeoutOrElse({
          duration: "5 seconds",
          orElse: () => Effect.fail(new Error("server did not shut down after last client left (I-4)"))
        })
      )
      const upAfter = yield* fs.exists(endpointFilePath())
      return { upDuring, upAfter, outcome }
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer))

    const r = await Effect.runPromise(program)
    expect(r.upDuring).toBe(true) // I-3: advertised while alive
    expect(r.outcome.health).toBe("ok")
    expect(r.outcome.created.title).toBe("E2E")
    expect(r.outcome.listed).toEqual([r.outcome.created]) // event -> projection over the wire
    expect(r.upAfter).toBe(false) // I-3/I-4: endpoint removed on zero-connection shutdown
  })

  it("delivers live domain events over the Events stream", async () => {
    const program = Effect.gen(function* () {
      const dbPath = join(dir, "events.db")
      const serverFiber = yield* Effect.forkChild(runServer({ dbPath, port: PORT }))
      yield* awaitEndpointUp

      const observed = yield* withClient({ port: PORT }, (client) =>
        Effect.gen(function* () {
          // Start listening, give the subscription time to attach, then create.
          const head = yield* Effect.forkChild(Stream.runHead(Stream.take(client.Events(), 1)))
          yield* Effect.sleep("150 millis")
          yield* client.SessionCreate({ title: "live" })
          return yield* Fiber.join(head)
        })
      )

      yield* Fiber.interrupt(serverFiber)
      return observed
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer))

    const observed = await Effect.runPromise(program)
    expect(Option.isSome(observed)).toBe(true)
    if (Option.isSome(observed)) {
      expect(observed.value._tag).toBe("SessionCreated")
      expect(observed.value.title).toBe("live")
    }
  })
})
```

> **If the first test hangs at "server did not shut down":** the socket-close → `onDisconnect` propagation is the integration assumption from Phase 5. The deterministic state machine already passed (Task 5.2), so the gap is the transport not closing the `Connect` stream's scope on disconnect. Investigate with `superpowers:systematic-debugging` against the installed `effect/unstable/rpc` — do not relax the test. The `sleep("150 millis")` in the second test is a pragmatic subscription-attach delay; if flaky on slow CI, raise it — it is not load-bearing for the lifecycle assertions in the first test.

- [ ] **Step 2: Run it.** Run: `bun run test -- test/integration/e2e-lifecycle.test.ts`
Expected: 2 passed. If `effect/unstable/rpc` transport APIs needed adjustment in Phases 5–6, this is where the real wiring is proven.

- [ ] **Step 3: Run the FULL suite + fitness + type-check.**

Run: `bun run test` → all green
Run: `bun run arch` → 0
Run: `bunx tsc --noEmit` → 0

- [ ] **Step 4: Commit**

```bash
git add test/integration/e2e-lifecycle.test.ts
git commit -m "test: add in-process end-to-end lifecycle and event-stream coverage"
```

### Task 7.2: Manual terminal verification of the compiled binary

**Agent:** manual-tester. This is the real-world proof the user asked for — driving the actual `yodea` binary in a terminal.

**Files:** none (verification only; the agent may write findings to the PR description, not the repo).

- [ ] **Step 1: Build the single binary**

Run: `bun run build`
Expected: `dist/yodea` is produced. (If `bun build --compile` errors on a dependency, note exactly which — that is a real finding about the single-artifact goal.)

- [ ] **Step 2: Isolate state**

```bash
export YODEA_HOME="$(mktemp -d)/yodea"
```
All discovery/db state now lives under `YODEA_HOME` (`server.json`, `events.db`).

- [ ] **Step 3: Auto-spawn + I-3 + I-4 (single command lifecycle)**

```bash
dist/yodea health --json
```
Verify and record:
- stdout is `{"status":"ok"}`.
- Immediately after the command returns, `cat "$YODEA_HOME/server.json"` does NOT exist (the server shut down once `health` disconnected — I-4), and `pgrep -f 'yodea server'` finds nothing.
- (Optional, to catch the file mid-flight) in a second shell during a slower command, confirm `server.json` exists with a live `pid`.

- [ ] **Step 4: Event-sourced durability across a zero-connection restart (the payoff)**

```bash
dist/yodea session create "alpha"     # auto-spawns server A, commits event, server A dies
dist/yodea session create "beta"      # auto-spawns server B, commits event, server B dies
dist/yodea session ls --json          # auto-spawns server C, rebuilds projection FROM DISK
```
Verify and record:
- The final `ls` lists BOTH `alpha` and `beta`, even though each ran against a *different* server process (capture the differing pids from the server logs or by watching `server.json`).
- This proves the event log in `events.db` is the durable source of truth and survives the I-4 zero-connection shutdowns — i.e. event sourcing works end to end.

- [ ] **Step 5: I-1 / I-2 structural reminder**

Run: `bun run arch` and confirm green. Note in the report that I-2 (one AppLayer per machine) is *structurally* guaranteed by the statically-enforced I-1 (the CLI cannot construct an AppLayer because it cannot import `composition/`), and that the only AppLayer construction site is `backend/composition/app.ts`.

- [ ] **Step 6: Report**

Produce a table: check → expected → observed → PASS/FAIL, with captured pids, `server.json` contents, and timings. Clean up: `pkill -f 'yodea server'` if any lingered; `rm -rf "$YODEA_HOME"`. **If any check FAILED, do not mark the phase complete** — report back to the orchestrator with the evidence.

### Task 7.3: Final review gate

**Agent:** code-reviewer, then orchestrator.

- [ ] **Step 1:** dispatch `code-reviewer` for a whole-branch audit: every C4 container/component present and wired, all four invariants enforced (I-1 test green and proven to bite, I-2 structural, I-3 file written/removed, I-4 shutdown observed in 7.1 and 7.2), no placeholders, `bun run test` + `bun run arch` + `bunx tsc --noEmit` all green.
- [ ] **Step 2:** On APPROVE, the foundation is complete. Proceed to the closing handoff (branch integration).

---

## Spec coverage (self-review map)

Every in-scope element of the C4 model and `BOUNDARIES.md` maps to a task. Deferred elements are listed explicitly so scope is unambiguous.

| C4 element / invariant | Where built |
|---|---|
| `cli.cliEntry` | Phase 6.4 / 6.5 (`commands/*`, `main.ts`) |
| `cli.cliRpcClient` | Phase 6.3 (`rpc-client.ts`) |
| `cli.cliDiscovery` | Phase 6.1 / 6.2 (`discovery.ts`) |
| `backend.rpcServer` | Phase 5.1 / 5.4 (`rpc-handlers.ts`, `http.ts`) |
| `backend.useCases` (+ domain) | Phase 4.2 (`use-cases.ts`), Phase 3.2 (`domain/session.ts`) |
| `backend.eventBus` | Phase 4.1 (`event-bus.ts`) |
| `backend.storage` (SQLite/WAL, event log) | Phase 3.1 / 3.3 (`event-store.ts`, `projections.ts`) |
| `backend.endpointFile` | Phase 2.4 (schema), Phase 5.3 (`endpoint-file.ts`) |
| `backend` composition / AppLayer | Phase 5.5 (`composition/app.ts`) |
| Shared RPC + event contracts | Phase 2 (`shared/*`) |
| **I-1** CLI client isolation | Phase 1 (fitness test + adversarial proof); re-checked via `bun run arch` in every later phase |
| **I-2** One AppLayer per machine | Structural via I-1 (Phase 1) + single construction site (Phase 5.5); noted in 7.2 |
| **I-3** Single discovery file | Phase 2.4 + Phase 5.3 + Phase 6.1; verified in 7.1 / 7.2 |
| **I-4** Zero-connection shutdown | Phase 5.2 (state machine) + 5.5 (wiring) + presence channel (5.1/6.3); verified in 7.1 / 7.2 |

**Deliberately deferred (NOT in this foundation — additive, do not change the seams above):**
- `desktop` container (Electron/Vite/React, `ui`, `state`, `rpcClient`, `discovery`).
- `backend.services` subtree: `acpClient`, `projectQueue` (`TxQueue` from `effect` core), `gitService`, `fileWatcher`, `highlighter`, `diffParser`, `terminal`.
- External `acpServer` and the recursive "agent invokes `yodea` CLI as a tool" loop.
- `configSecrets`: only env-based config (`YODEA_HOME`/`YODEA_DB`/port) is built; OS-keychain secrets are deferred.
- Ephemeral-port negotiation (fixed `51789` for now), `SqliteMigrator` (single `CREATE TABLE IF NOT EXISTS` for now), and historical-event replay on the `Events` stream (live-only for now).

## Definition of done

- [ ] All phases' tests green: `bun run test` (unit + integration, incl. the in-process e2e).
- [ ] `bun run arch` green; the I-1 test has been proven to *fail* on a forbidden import (Task 1.3 in history).
- [ ] `bunx tsc --noEmit` clean under `strict`.
- [ ] `bun run build` produces `dist/yodea`; `manual-tester` confirmed auto-spawn, zero-connection shutdown, and event-sourced durability across a restart (Task 7.2).
- [ ] `code-reviewer` APPROVED the final branch audit (Task 7.3).
- [ ] All work is on `feat/architectural-foundation`; `develop` has received no direct commits.

---

## Closing handoff — integrate without dirtying `develop`

When the Definition of done is met, integrate via a **reviewed PR** (never a direct commit to `develop`). Use `superpowers:finishing-a-development-branch`:

```bash
git push -u origin feat/architectural-foundation
gh pr create --base develop --title "Yodea architectural foundation (CLI-only walking skeleton)" \
  --body "Implements the event-sourced backend + thin CLI client + invariants I-1..I-4. See docs/superpowers/plans/2026-05-28-yodea-architectural-foundation.md."
```

Do not merge to `develop` locally; let the PR review + CI (which runs `bun run test` + `bun run arch`) gate the merge.

## Execution

**Plan complete and saved to `docs/superpowers/plans/2026-05-28-yodea-architectural-foundation.md`.** Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh `tdd-implementer` per task, with a `code-reviewer` pass at each phase gate and `manual-tester` for Phase 7. Fast iteration, review between tasks. (REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`.) Note: Phase 0.4 must run first to create the agent definitions before later phases can dispatch them.
2. **Inline Execution** — execute tasks in this session in batches with checkpoints. (REQUIRED SUB-SKILL: `superpowers:executing-plans`.)

