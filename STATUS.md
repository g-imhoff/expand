# Yodea — Architectural Foundation: Build Status

**Date:** 2026-05-29 · **Branch:** `feat/architectural-foundation` (PR into `develop`; `develop` deliberately untouched).

The CLI-only **walking skeleton** is fully implemented, reviewed, and tested on **Effect v4 beta**. Every architectural seam from the C4 model is exercised end-to-end and all four invariants (I-1..I-4) are enforced *and behaviorally proven at runtime*.

## Verification (all green — re-run any of these)
```
bunx tsc --noEmit     # exit 0 (strict + exactOptionalPropertyTypes + noUncheckedIndexedAccess)
bun run test          # 33 tests / 18 files passed (reliably green x5)   (bun --bun vitest)
bun run arch          # 0 dependency violations       (dependency-cruiser, enforces I-1)
bun run build         # produces dist/yodea (single ~101MB binary, 351 modules)
```
> **Post-completion fix (test reliability):** the I-1 fitness test shells out to `bunx depcruise`
> (full TS pre-compilation graph analysis), which grew to ~6.4s as the backend filled in — over
> vitest's 5s default — so it began failing consistently *after* the build was "done" (the earlier
> green predated the codebase crossing 5s). Fixed by raising `testTimeout`/`hookTimeout` to 30s in
> `vitest.config.ts` (config only; the DO-NOT-MODIFY I-1 test and the cruiser rules are unchanged, so
> the guarantee is intact). Now reliably green: 5/5 full-suite runs, 33/33 each. See `docs/PR-REVIEW-GUIDE.md` §8 C1.
Manual (compiled binary, isolated `YODEA_HOME`): `yodea health --json` → `{"status":"ok"}`; back-to-back `project create alpha && project create beta && project ls --json` lists both (each via a distinct freshly-spawned, then self-terminated, server — **event-sourced durability across zero-connection restarts**); `server.json` written on startup and removed on shutdown (I-3); server self-shuts-down when the last WebSocket connection closes (I-4); 4-way concurrent spawn converges on one shared backend.

## What was built
- **Shared contracts** (pure, I-1-safe): `DomainEvent`/`ProjectCreated`, `Project` read-model, `Endpoint` + discovery path, `YodeaRpcs` RPC group (Health, ProjectCreate, ProjectList, Connect[stream], Events[stream]).
- **Event-sourced storage:** append-only SQLite `events` table (source of truth, WAL), pure `projectsFromEvents` fold, `ProjectProjection`.
- **Hexagonal core:** `EventBus` (PubSub broadcast), `UseCases` (append-then-publish commit path; queries read projections).
- **Transport & lifetime:** RPC-over-WebSocket (NDJSON), `ConnectionTracker` (I-4 state machine), endpoint file (I-3), single `runServer` AppLayer (I-2).
- **Thin CLI client** (I-1 isolated): discovery, find-or-spawn-under-lock, RPC client holding a `Connect` presence channel, `health`/`project` commands, the `server` subcommand (sole composition importer), `main`.
- **Invariant enforcement:** `dependency-cruiser` I-1 rules + DO-NOT-MODIFY vitest test (adversarially proven to fail on a forbidden import) + CODEOWNERS.
- **Subagent definitions:** `.claude/agents/{tdd-implementer,code-reviewer,manual-tester}.md`.

## Notable deviations from the original plan (all deliberate; commit history documents each)
1. **Stack: Effect 3.x → Effect v4 beta `4.0.0-beta.74`** (per request). All framework code is under `effect/unstable/*` or `effect` core; only `@effect/platform-bun` + `@effect/sql-sqlite-bun` remain separate. Devtools at latest: TypeScript 6.0.3, vitest 4.1.7, dependency-cruiser 17.4.2. (The original v4-migration-reference plan doc has since been removed from the tree — it lives only in git history.) **The committed code under `apps/cli/` is the source of truth**; some snippets in that plan doc predate the runtime fixes below.
2. **Toolchain:** tests run via `bun --bun vitest` (the Node loader can't resolve `bun:sqlite`). `tsconfig` needs `ignoreDeprecations: "6.0"` (TS 6 deprecates `baseUrl`) and `skipLibCheck: true` is load-bearing for effect v4 `.d.ts`.
3. **v4 API corrections vs the migration reference:** `yield* SqlClient` (the named export IS the tag; `SqlClient.SqlClient` is `undefined`); client type `RpcClient.FromGroup<typeof YodeaRpcs, RpcClientError.RpcClientError>`; service error channels widened to `SqlError | SchemaError`; `Effect.timeoutOrElse` (not the removed `timeoutFail`); `Effect.forkChild`.
4. **Runtime integration fixes (found by the e2e + manual testing, fixed at the right seam):**
   - Bun graceful-stop deadlocks while a WS is open → transport built in a child scope closed with a bounded **~1s grace window**.
   - Process didn't exit on clean self-shutdown → `process.exit(0)` at the CLI entry point.
   - Back-to-back CLI commands raced/hung → **ephemeral port** (read back from the bound listener; no fixed 51789), **eager endpoint-file removal** the instant I-4 shutdown arms, and a **bounded client connect-timeout with re-spawn** on a stale endpoint.
   - **Stale spawn-lock recovery:** the `.lock` is stamped with pid+timestamp and treated as stale (dead pid / >30s) so a crashed mid-spawn process can't permanently wedge the CLI.
   - Quieted the benign `499 ClientAbort` shutdown log (real 5xx still logged).

## Known limitations (non-blocking)
- Last-client shutdown takes ~1s (the documented Bun graceful-stop grace window). If a future v4 beta exposes a force-stop, drop the window.
- `apps/cli/server/http.ts` relies on single-build layer memoization to avoid a second listener (correct; note for any future composition refactor).
- Effect v4 is **beta** with modules under `unstable/` — expect breaking changes between betas; re-pin deliberately.

## Deliberately deferred (per plan scope — not missing work)
Electron desktop; the real backend services (Git, Terminal, FileWatcher, Highlighter, DiffParser, ACP client) + the per-project `TxQueue`; the ACP agent loop (agent invoking the `yodea` CLI as a tool); OS-keychain secrets (only env config built); historical-event replay on the `Events` stream (live-only).

## Next step
Open a PR `feat/architectural-foundation` → `develop` (do **not** merge to `develop` directly). The seams are proven; features can be built on top by adding event types (extend the `DomainEvent` union + projection fold) and services (one Layer at a time).

---

# Electron + Ink Frontends (branch `feat/electron-ink-frontends`)

Two new Effect-first frontends — an **Ink terminal app** and an **Electron desktop app** — attach to the existing backend over RPC-over-WebSocket and drive the project feature (create + list) with **live cross-frontend updates**. The backend stays in `apps/cli` as the spawnable `yodea` binary; all three frontends discover-or-spawn it and share one running backend.

## Verification (all green — re-run any of these)
```
bunx tsc --noEmit          # exit 0
bun run typecheck:desktop  # exit 0 (apps/desktop tsconfig: DOM lib for renderer, Node/Electron for main)
bun run test               # 48 tests / 26 files passed   (bun --bun vitest)
bun run arch               # 0 dependency violations, 62 modules cruised (generalized I-1)
bun run build              # produces dist/yodea (single binary, 355 modules)
bun run build:desktop      # produces apps/desktop/out/{main,preload,renderer}
```

## What was built
- **`packages/contracts`** (alias `@yodea/contracts`): the pure contract, moved out of `apps/cli/shared/` (`rpc`, `events`, `project`, `endpoint`). The `@yodea/shared` alias is gone; all backend/CLI imports retargeted.
- **`packages/client-core`** (alias `@yodea/client-core`): the runtime-agnostic connection brain — discovery (find-or-spawn-under-lock), `withClient`, and a long-lived `ProjectStore`. The single cross-runtime seam is `RuntimeAdapter` (a `protocolLayer(url): Layer<RpcClient.Protocol>` + an `spawnBackend: Effect`). Two adapters ship: a **Bun adapter** (`@effect/platform-bun` `BunSocket` + `Bun.spawn`) and a **Node adapter** (`makeNodeAdapter` — `ws` package as `Socket.WebSocketConstructor` + `child_process` spawn). Adapters live behind explicit subpaths so a Node build never pulls the Bun adapter and vice-versa.
- **`ProjectStore`** — the live store: a scoped Effect service holding a `SubscriptionRef<ReadonlyArray<Project>>` seeded from the `ProjectList` snapshot and folded forward by every `ProjectCreated` on the `Events` stream. Holds its `Connect` presence for the runtime's lifetime. This is the **one-backend-many-frontends** payoff — a create through one frontend appears live in the others.
- **`apps/tui`** (Ink 7 + React 19): pure presentational `ProjectList` / `CreateInput` components, a `useProjects` bridge (drives `SubscriptionRef.changes` → React `setState` via a `ManagedRuntime`), and a `main.tsx` entry that wires the Bun adapter. Tested with `ink-testing-library` against a fake `ProjectStore`.
- **`apps/desktop`** (Electron 42 + electron-vite 5 + React 19): **main** owns the connection (Node adapter + `ProjectStore` via `NodeRuntime`); the **renderer** is pure UI over a typed `contextBridge` (`window.yodea`) and never imports `client-core` or the main process. IPC wiring is a dependency-injected module (no `electron` import) so it unit-tests under Bun. Minimal app-local `package.json` (Electron needs a `main` entry) + `tsconfig.json`; deps stay in root.

## Invariant I-1, generalized
The original I-1 (CLI may not import backend internals) is **generalized to all frontends**: `apps/cli/cli`, `apps/tui`, `apps/desktop`, and `packages/client-core` may import only `packages/contracts` + `packages/client-core` (+ npm) — never `apps/cli` backend internals (server/composition/application/domain/db). The lone exception is `apps/cli/cli/commands/server.ts`, which imports `apps/cli/composition` to boot the backend. A second rule isolates the Electron renderer (`apps/desktop/src/renderer`): it may not import `client-core` or the Electron main process. The DO-NOT-MODIFY I-1 fitness test was widened and **re-proven non-vacuous** (a backend-import from client-core AND a renderer-import from client-core both trip the guard).

## New scripts
- `dev:tui` — `bun apps/tui/main.tsx` (Ink TUI from source).
- `dev:desktop` — `electron-vite dev` in `apps/desktop`.
- `build:desktop` — `electron-vite build` → `apps/desktop/out/{main,preload,renderer}`.
- `typecheck:desktop` — `tsc --noEmit -p apps/desktop/tsconfig.json` (kept out of the root typecheck because of its DOM/Electron libs).

## Dependency note (Node adapter)
The Node adapter adds `@effect/platform-node` (`4.0.0-beta.74`, same beta wave) and `ws` (+ `@types/ws` dev). Both are **allowed** — Node has no global WebSocket, so the adapter provides one from `ws`; `@effect/platform-node` covers Electron-main platform services. These are NOT the forbidden `@effect/*` 3.x packages.

## Deferred (out of scope, per spec)
Packaging/installers/code-signing; historical event replay; auth beyond the existing token; Bun workspaces; any new domain feature beyond project create + list.

---

# Agent-first CLI architecture (branch `feat/agent-first-cli`)

The `yodea` CLI is reworked to be **agent-first**: every command emits a versioned, machine-readable JSON envelope on stdout by default, errors carry a stable taxonomy mapped to stable exit codes, and stdout/stderr are strictly separated (data vs diagnostics). This makes the binary safe to invoke as a tool by an autonomous agent — branch on the exit code, parse the single-line JSON envelope.

## Verification (all green — re-run any of these)
```
bunx tsc --noEmit     # exit 0
bun run test          # 80 tests / 35 files passed   (bun --bun vitest)
bun run arch          # 0 dependency violations, 68 modules cruised
bun run build         # produces dist/yodea (single ~101MB binary, 364 modules)
```
Manual (real compiled binary, isolated `YODEA_HOME`): `yodea health` → `{"apiVersion":"yodea/v1","kind":"Health","data":{"status":"ok"}}` (exit 0); `project create alpha` → `kind:"Project",created:true` (exit 0); a duplicate `project create alpha` → `kind:"Error",code:"PROJECT_EXISTS",retryable:false` on stdout, exit **5**; `project create alpha --ensure` → `created:false` idempotent no-op (exit 0); `project list` → `kind:"ProjectList",count:1` (exit 0); an invalid name (e.g. empty) → `code:"INVALID_ARGUMENT"` JSON on **stderr**, exit **2**, stdout clean (data channel never polluted by errors). `--format text` renders the same data as plain lines.

## What was built
- **Versioned JSON envelope** (`packages/contracts/cli.ts`): every payload carries `apiVersion:"yodea/v1"` and a `kind` discriminant — `ProjectEnvelope` (adds `created:boolean`), `ProjectListEnvelope` (adds `count`), `HealthEnvelope`, and `ErrorEnvelope`. A versioning-guard snapshot pins the envelope shapes so a breaking change to the wire contract trips a test.
- **`YodeaCliError` taxonomy → stable exit codes:** `0` success/help; `2` usage (`INVALID_ARGUMENT` / `INVALID_OPTION` / `UNKNOWN_COMMAND`); `5` `PROJECT_EXISTS`; `6` `BACKEND_UNREACHABLE` (retryable); `1` `UNEXPECTED`; `130` SIGINT. The `ErrorEnvelope` exposes `code`, `message`, `retryable`, and (where useful) `input`/`hint`.
- **Strict stream discipline:** stdout = data only; stderr = diagnostics + error envelopes. Agents read the data envelope from stdout and, on a non-zero exit, the error envelope from stderr.
- **Global options:** `--format json|text` (default **json**) and `--quiet`.
- **Single top-level `renderErrors` seam** (`apps/cli/cli/run.ts`): catches BOTH handler-domain failures AND `YodeaClientLive` layer-acquisition failures (e.g. backend unreachable), maps them through the taxonomy, and writes the error envelope + exit code. A custom `CliOutput` JSON formatter renders parse/usage errors as envelopes too.
- **`defineCommand` success-rendering seam:** every command returns its typed payload and the seam wraps it in the right envelope for the active `--format`.
- **`YodeaClient` as a scoped `Context` service** (`packages/client-core/yodea-client.ts`): holds the I-4 presence channel (`Connect`) for the lifetime of the work; `withClient` is reimplemented over it.
- **`ProjectCreate` idempotency:** the RPC gains an error channel (`ProjectAlreadyExists`) and an `ensure` flag; server-side name uniqueness is enforced. `--ensure` makes create an idempotent no-op (returns the existing project, `created:false`); a strict create on a duplicate fails with exit 5.
- **`ls` → `list`** (clearer, less abbreviated command name).

## Notable decisions/deviations
- The envelope is **single-line JSON** per invocation (one object on stdout), not a stream — agents consume one result per command run.
- The error taxonomy is mapped at one seam only (`run.ts`); commands raise typed domain errors and never format their own output, so exit-code/envelope policy lives in exactly one place.

## Known limitations (documented, accepted)
1. On a **parse error** the framework prints the human help block to **stdout** while the JSON error envelope goes to **stderr** + exit 2. Agents should branch on the exit code and read stderr (not assume stdout is always parseable JSON). Verified by manual smoke test.
2. `createProject` name-uniqueness is **list-then-check**, so a TOCTOU window exists for two simultaneous same-name creates. Acceptable under the single-backend invariant (I-2); the deferred per-project `TxQueue` closes it.
3. On the rare **stale-endpoint retry** path, the `YodeaClientLive` layer may leave up to 2 dead-socket transports until layer close — harmless (dead ports, scope-bounded; reclaimed on layer teardown).

## Follow-up doc nit (not done here)
`docs/architecture/yodea.c4` still labels the CLI technology as `@effect/cli`; the actual stack is Effect v4 beta `effect/unstable/cli`. Flagged for an architecture-owner doc fix — left untouched here as it is a CODEOWNERS-governed architecture document.

## Deferred
`project get` / `project delete`; a `yodea schema` introspection command; config files; shell completions; ANSI color output.

---

# Desktop architecture redesign (branch `feat/desktop-architecture`)

The Electron desktop app was rebuilt onto a clean, scalable base organized around the **project** domain. The renderer is now **"just another `YodeaRpcs` frontend"**: it speaks the *same* contract to the Electron **main** process over a per-window `MessageChannelMain` port; main maps those calls onto the shared `ProjectStore`. Design spec + plan are local under `docs/superpowers/` (gitignored); the research report is at `docs/research/2026-06-01-electron-best-practices.md`.

## Verification (all green — re-run any of these)
```
bunx tsc --noEmit          # exit 0
bun run typecheck:desktop  # exit 0
bun run test               # 51 tests / 30 files passed   (bun --bun vitest)
bun run arch               # 0 violations, 72 modules cruised (I-1 extended to the preload)
bun run build              # dist/yodea (single binary)
bun run build:desktop      # out/{main/index.mjs, preload/index.cjs, renderer}
xvfb-run -a bun run e2e:desktop  # 1 passed — create a project, see it live (Playwright _electron)
```

## What was built
- **Typed IPC seam (centerpiece):** `RpcServer.makeNoSerialization` (main, `src/main/rpc/server.ts` + `handlers.ts` delegating to `ProjectStore`) ↔ `RpcClient.makeNoSerialization` (renderer, `src/renderer/rpc/client.ts`) over a per-window `MessageChannelMain` port (`src/main/rpc/transport.ts`). The `YodeaRpcs` contract is the single source of truth on both the backend↔main (WebSocket) and main↔renderer (MessagePort) hops — adding a feature is now a new Rpc + a handler + a hook, no per-feature IPC plumbing. The hand-mirrored `api.d.ts` bridge is gone.
- **`ProjectStore` gained a live `events: Stream<DomainEvent>`** (PubSub tee) so each window's `Events` handler gets its own live subscription — the only `client-core` change.
- **Effect-first renderer:** a small `ManagedRuntime` runs the `RpcClient`; **TanStack Query** is the React cache, seeded by `ProjectList` and folded forward by the live `Events` stream (`features/projects/data/{project-store,use-projects}.ts`); **TanStack Router** shell: `/` project picker → `/p/:projectId` workspace.
- **Security:** `sandbox:true` + the preload converted to **CommonJS** (`index.cjs` — a sandboxed ESM preload silently breaks on Electron 42); strict CSP for the packaged renderer (dev relies on the dev server); `will-navigate` + `setWindowOpenHandler` lockdown; `:9222` CDP gated behind `!isPackaged && YODEA_DEVTOOLS_CDP=1`.
- **Bugs fixed structurally:** the multi-window `ipcMain.handle` duplicate-registration crash (now per-window `RpcServer` + a single captured teardown, no post-`closed` `webContents` access); the leaked push fiber / send-after-destroy (per-window port scope torn down on `closed`/`render-process-gone`); `runtime.dispose()` moved to `before-quit`.

## Invariant I-1, extended to the preload
The `renderer-must-not-import-client-core` rule now covers `apps/desktop/src/(renderer|preload)` — the preload is a pure `MessagePort` broker. The renderer/preload import only `@yodea/contracts` + `effect`/`effect/unstable/rpc` + npm UI libs, never `client-core` or the main process. The DO-NOT-MODIFY I-1 fitness test was re-proven **non-vacuous** (a forbidden `preload → client-core` import trips the rule). `BOUNDARIES.md` + `.dependency-cruiser.cjs` + the test updated together.

## New scripts / deps
- `e2e:desktop` — `bun run build:desktop && playwright test -c apps/desktop/e2e/playwright.config.ts` (builds first so it never tests a stale `apps/desktop/out/`; `_electron.launch` against the built app; isolated `YODEA_HOME`, absolute `YODEA_BACKEND_CMD`).
- Added `@tanstack/react-query`, `@tanstack/react-router`, `@playwright/test`, `electron-playwright-helpers`.

## Deferred (per spec)
Typed domain errors (pattern established; coarse `orDie` for now); multi-window (the per-window-port transport already supports it); packaging/Fuses/asar/`protocol.handle`/deep-links; persistence (recent-projects, window bounds); reconnect-after-backend-crash UX; effect-atom (blocked on Effect v3).
