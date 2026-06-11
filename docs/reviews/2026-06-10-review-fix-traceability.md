# Review-fix traceability — feat/architectural-foundation full-branch review

Maps every finding addressed by the `fix/full-branch-review-p0-p1` branch to its implemented solution. Source review: 2026-06-09 full-branch review of `feat/architectural-foundation` (range `9a5fa78..9ce030f`; 61 adversarially-verified findings, 5 critical). Each row's status reads either `implemented (<commit>)` or `deferred (<reason>)` now that the work has landed.

## Finding → solution matrix

| # | Review finding (severity) | Task(s) | Status |
|---|---|---|---|
| 1 | Backend HTTP/WS server binds 0.0.0.0 while advertising 127.0.0.1 (critical) | 1 | implemented (4e4d849) |
| 2 | No authentication anywhere: endpoint token generated but never sent or verified (critical) | 2 | implemented (1abffa6, 9541bf4) |
| 3 | Endpoint discovery file world-readable; db 0644 (important — permissions half) | 3 | implemented (4571a8a) |
| 4 | Zero test coverage of the network trust boundary (critical) | 1–4 | implemented (4e4d849, 1abffa6, 4571a8a, 885a703) |
| 5 | Desktop default backend spawn path resolves to nonexistent `<repo>/server/main.ts` (critical) | 5 | implemented (57fc8ee) |
| 6 | One undecodable event row permanently bricks every operation (critical) | 6 | implemented (4fe6b71, 6a5e124) |
| 7 | Server wraps runServer in ensuring(process.exit(0)) (important) | 7 | implemented (f947160, 86e3e75) |
| 8 | Standalone yodea-server fails first run — no mkdir for db parent (important) | 7 | implemented (f947160) |
| 9 | YODEA_HOME split-brain: endpoint honors it, db path does not (important) | 7 | implemented (86e3e75) |
| 10 | Spawned daemon produces zero retrievable output — no log destination (important) | 8 | implemented (4255b44) |
| 11 | No env-driven minimum log level (important) | 8 | implemented (4255b44) |
| 12 | Backend spawn failures unhandled in both adapters (important) | 9 | implemented (28d104d) |
| 13 | YODEA_BACKEND_CMD: uncaught JSON.parse at module load (important) | 9 | implemented (28d104d) |
| 14 | No forked fiber observes failure; Effect v4 logs nothing for unobserved fibers (important) | 10 (18, 22) | implemented (686519b) |
| 15 | Events carry no id/sequence/cursor; list+subscribe racy by contract (important) | 11–14 | implemented (f08c2a5, 781a942, 4692020, 3befb08) |
| 16 | Renderer store fetches list before subscribing — events in the gap lost (important) | 14 | implemented (3befb08) |
| 17 | No expected-version or write serialization on append (important) | 16 | implemented (3bfccb0) |
| 18 | store.append and bus.publish non-atomic (important) | 16 | implemented (3bfccb0) |
| 19 | Wire/event schemas accept bare strings for name/id/directory (important — RPC payload half) | 15 | implemented (a3b3e24) |
| 20 | validateDirectory accepts plain files; no canonicalization (important) | 15 | implemented (a3b3e24) |
| 21 | No negative tests asserting schemas reject malformed input (important) | 15 | implemented (a3b3e24) |
| 22 | client-core ProjectStore lacks rpc-client's readiness gate / timeout / retry (important) | 17 | implemented (762ac4d) |
| 23 | No reconnect or liveness after connect — silent zombie stores (important) | 18 | implemented (ae1a2fc, c43f4b7) |
| 24 | Desktop seam fake Health/Connect (important — `ensure`/`created` forwarding deferred) | 19 | implemented (d860c05) |
| 25 | TUI mutations fire-and-forget; every failure silently discarded (important) | 20 | implemented (6036d24) |
| 26 | Desktop rename/delete failures invisible (important) | 21 | implemented (02cdfd0) |
| 27 | Renderer boot has no failure path — 'Connecting…' forever (important) | 22 | implemented (3aae9b0) |
| 28 | dependency-cruiser exclude treats 'test' as unanchored substring (important) | 23 | implemented (2f4cbf5, 88e2418) |
| 29 | BOUNDARIES.md contradicts its own enforcement tests (important) | 23 | implemented (2f4cbf5) |
| 30 | CODEOWNERS routes invariants to placeholder team (important) | 24 | implemented (a37b716) |
| 31 | Effect beta lockstep enforced by nothing (important) | 25 | implemented (bfe8af0) |
| 32 | Desktop e2e not hermetic — shares global ~/.yodea discovery (important) | 26 | implemented (a009360) |
| 33 | e2e end-state assertions verify dialog-closed, not persisted data (important) | 26 | implemented (a009360) |
| 34 | No CI pipeline at all (important) | 27 | implemented (64e8b44, 938ef81) |
| 35 | cert:cli:build is a bare alias — no artifact smoke test (part of #34) | 27 | implemented (64e8b44) |

## Consciously deferred

| Review finding | Status / reason |
|---|---|
| Endpoint-file atomic write + pid-checked delete (split-brain races) | deferred — needs a lifecycle design pass (lock ownership, adoption); permissions half lands in Task 3 |
| protocolVersion-mismatch diagnostics (silent second spawn) | deferred (PROTOCOL_VERSION bumped to 2; surfacing mismatch instead of re-spawning needs a discovery error channel — follow-up) |
| Desktop `ensure`/`created` forwarding across the seam | deferred (requires widening client-core createProject result; desktop seam still fabricates created — follow-up) |
| Event-payload schema branding for stored events + schema-evolution/upcaster seam | deferred (wire payloads branded per D8; tightening stored-event schemas is a migration problem — old rows must keep decoding) |
| Projection caching, double-refold, unbounded PubSub bounds, renderer selectors, palette virtualization, startup prewarm (perf findings) | deferred — accepted at current scale; revisit before AI-agent event rates |
| Electron nav-allowlist pinning, MessagePort origin check, permission handlers, fuses/asar | deferred — renderer-trust hardening batch scheduled with the packaging work |
| Health/doctor diagnostics enrichment, correlation ids, endpoint-eviction forensics | deferred — observability follow-up; minimal file logger + log level land in Task 8 |
| skipLibCheck no-skipLibCheck baseline snapshot | deferred — upgrade-runbook artifact |
| 28 minor findings | deferred — see the review report's minors list |

## Review-discovered follow-ups

Notes raised by the per-task code reviews during this branch's execution. None block the P0/P1 scope; they are recorded here so the follow-up work is discoverable.

### Security / correctness edges
- Directory-conflict canonicalization is asymmetric: stored `project.directory` values are not canonicalized at write time, so two different symlink aliases of one physical directory can still coexist. Follow-up: canonicalize before storing (Task 15 review).
- `validateDirectory` maps every `fs.stat` failure (EACCES, ELOOP, I/O) to reason `not-found`; `fs.realPath` failure dies (tiny TOCTOU window after stat) instead of failing typed (Task 15 review).
- Endpoint-file writes have a brief 0644 window on stale-path overwrite; pre-existing `~/.yodea` dirs are not retroactively tightened; WAL/SHM sidecar permissions are unasserted (Task 3 review).
- Corrupt `ProjectDeleted` rows are skipped by the tolerant decoder, which can resurrect a deleted project in the fold (Task 6 review).
- A stale `fromSeq` greater than the current head yields an empty backlog rather than an error (stale-cursor blackout) (Task 12 review).

### Connection/status semantics (Tasks 17–19)
- The store's reconnect policy duplicates the rpc socket protocol's internal `defaultRetryPolicy` — two stacked forever-retry mechanisms; consider passing an explicit retryPolicy so the store owns reconnection unambiguously.
- Mutations issued while `status !== "connected"` resolve a possibly-dead client: typed `RpcClientError` at best, an interrupt defect at worst. Consumers must gate on `status`; the TUI currently does not (failures render as terse internals like "SocketCloseError: 1006").
- `status === "connected"` can lag actual backend death by up to the socket ping-timeout (conservative direction); reconnect retries forever by design (status is the escalation surface); the events PubSub is unbounded under a slow subscriber.
- Desktop seam `Events fromSeq` remains a live-stream filter (dedupe-only, no replay); `Connect` is an infinite stream that degrades to permanent `false` on fatal store-loop failure.
- Health's `Effect.die` on disconnect serializes as a wire-level Defect frame which tears down ALL in-flight requests on the shared renderer client — Health must remain boot-only (it is today). Real fix: typed Health success/error in the contract, batched with the ensure/created seam follow-up.

### UX / frontend polish
- Desktop dialogs show raw error tags ("ProjectNameConflict") via a describeError helper now copied in three dialog files; the TUI has a richer per-tag version. Follow-up: extract a shared renderer-local helper and humanize messages in one pass.
- RenameDialog's submit button has no pending/disabled state (double-click can double-fire); DeleteProjectDialog flow lacks a stay-open-on-failure unit test (covered indirectly).
- BootError renders the full `Cause.pretty` output (multi-line stack noise) in a non-pre paragraph; `BOOT_TIMEOUT` (10s) has no env override; the boot-timeout path has no automated test (component-level only).
- TUI `clearError` is exported but unconsumed (plan-mandated hook signature).

### Observability / robustness
- File logger failure at boot is fatal (e.g. EACCES on the log dir); no log rotation; invalid `YODEA_LOG_LEVEL` falls back silently (Task 8 review).
- An empty-array `YODEA_BACKEND_CMD` falls through to the default spawn path on the node adapter (Task 9 review).
- Backend env validation logic is triplicated across adapters/entrypoints (Task 9 review).
- The `supervised` helper exists as three copies (client-core + two desktop) per the renderer-isolation rule; keep them in sync manually.
- `ProjectUseCases.listProjects` is an unused surface on the server (dead code candidate).
- client-core integration tests orphan their spawned backends (unref'd; they self-exit on disconnect) — a shared kill-on-scope-close spawn helper would tighten this.
- `reconnect.test.ts` is the most CI-timing-sensitive spec (stacked backoff + real respawn under a 60s cap) — watch on cold CI runners.

### Governance / CI hygiene
- e2e "persisted-data" assertions prove event-log round-trip, not disk durability across a backend restart (would need a relaunch against the same YODEA_DB).
- CI workflow: no concurrency group, no timeout-minutes, actions pinned by tag not SHA, no explicit permissions block — acceptable for a personal-repo first pipeline, tighten later.
- The lockstep fitness test reads the ROOT package.json only — extend it if a sub-package ever declares its own effect dependency.
- The depcruise exclude patterns are segment-exact; future artifact dirs named e.g. `dist-electron/` would need a new pattern.
- `docs/PR-REVIEW-GUIDE.md` still describes the old CODEOWNERS placeholder and the old rule name as live problems — update/strike those findings.
- Seven hand-rolled `Layer.succeed(ProjectStore, …)` test fakes exist; a shared `makeFakeProjectStore(overrides)` helper would collapse them.
