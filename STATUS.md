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
