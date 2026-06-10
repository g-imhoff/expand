# Review-fix traceability — feat/architectural-foundation full-branch review

Maps every finding addressed by the `fix/full-branch-review-p0-p1` branch to its implemented solution. Source review: 2026-06-09 full-branch review of `feat/architectural-foundation` (range `9a5fa78..9ce030f`; 61 adversarially-verified findings, 5 critical). Statuses are flipped from `planned` to `implemented (<commit>)` or `deferred (<reason>)` as the work lands.

## Finding → solution matrix

| # | Review finding (severity) | Task(s) | Status |
|---|---|---|---|
| 1 | Backend HTTP/WS server binds 0.0.0.0 while advertising 127.0.0.1 (critical) | 1 | planned |
| 2 | No authentication anywhere: endpoint token generated but never sent or verified (critical) | 2 | planned |
| 3 | Endpoint discovery file world-readable; db 0644 (important — permissions half) | 3 | planned |
| 4 | Zero test coverage of the network trust boundary (critical) | 1–4 | planned |
| 5 | Desktop default backend spawn path resolves to nonexistent `<repo>/server/main.ts` (critical) | 5 | planned |
| 6 | One undecodable event row permanently bricks every operation (critical) | 6 | planned |
| 7 | Server wraps runServer in ensuring(process.exit(0)) (important) | 7 | planned |
| 8 | Standalone yodea-server fails first run — no mkdir for db parent (important) | 7 | planned |
| 9 | YODEA_HOME split-brain: endpoint honors it, db path does not (important) | 7 | planned |
| 10 | Spawned daemon produces zero retrievable output — no log destination (important) | 8 | planned |
| 11 | No env-driven minimum log level (important) | 8 | planned |
| 12 | Backend spawn failures unhandled in both adapters (important) | 9 | planned |
| 13 | YODEA_BACKEND_CMD: uncaught JSON.parse at module load (important) | 9 | planned |
| 14 | No forked fiber observes failure; Effect v4 logs nothing for unobserved fibers (important) | 10 (18, 22) | planned |
| 15 | Events carry no id/sequence/cursor; list+subscribe racy by contract (important) | 11–14 | planned |
| 16 | Renderer store fetches list before subscribing — events in the gap lost (important) | 14 | planned |
| 17 | No expected-version or write serialization on append (important) | 16 | planned |
| 18 | store.append and bus.publish non-atomic (important) | 16 | planned |
| 19 | Wire/event schemas accept bare strings for name/id/directory (important — RPC payload half) | 15 | planned |
| 20 | validateDirectory accepts plain files; no canonicalization (important) | 15 | planned |
| 21 | No negative tests asserting schemas reject malformed input (important) | 15 | planned |
| 22 | client-core ProjectStore lacks rpc-client's readiness gate / timeout / retry (important) | 17 | planned |
| 23 | No reconnect or liveness after connect — silent zombie stores (important) | 18 | planned |
| 24 | Desktop seam fake Health/Connect (important — `ensure`/`created` forwarding deferred) | 19 | planned |
| 25 | TUI mutations fire-and-forget; every failure silently discarded (important) | 20 | planned |
| 26 | Desktop rename/delete failures invisible (important) | 21 | planned |
| 27 | Renderer boot has no failure path — 'Connecting…' forever (important) | 22 | planned |
| 28 | dependency-cruiser exclude treats 'test' as unanchored substring (important) | 23 | planned |
| 29 | BOUNDARIES.md contradicts its own enforcement tests (important) | 23 | planned |
| 30 | CODEOWNERS routes invariants to placeholder team (important) | 24 | planned |
| 31 | Effect beta lockstep enforced by nothing (important) | 25 | planned |
| 32 | Desktop e2e not hermetic — shares global ~/.yodea discovery (important) | 26 | planned |
| 33 | e2e end-state assertions verify dialog-closed, not persisted data (important) | 26 | planned |
| 34 | No CI pipeline at all (important) | 27 | planned |
| 35 | cert:cli:build is a bare alias — no artifact smoke test (part of #34) | 27 | planned |

## Consciously deferred

| Review finding | Status / reason |
|---|---|
| Endpoint-file atomic write + pid-checked delete (split-brain races) | deferred — needs a lifecycle design pass (lock ownership, adoption); permissions half lands in Task 3 |
| protocolVersion-mismatch diagnostics (silent second spawn) | deferred — versioning UX decision pending; PROTOCOL_VERSION bump in Task 12 makes mismatch detectable |
| Desktop `ensure`/`created` forwarding across the seam | deferred — requires widening client-core createProject result; tracked for the seam-honesty follow-up |
| Event-payload schema branding for stored events + schema-evolution/upcaster seam | deferred — stored-event migration problem; wire-payload branding lands in Task 15 |
| Projection caching, double-refold, unbounded PubSub bounds, renderer selectors, palette virtualization, startup prewarm (perf findings) | deferred — accepted at current scale; revisit before AI-agent event rates |
| Electron nav-allowlist pinning, MessagePort origin check, permission handlers, fuses/asar | deferred — renderer-trust hardening batch scheduled with the packaging work |
| Health/doctor diagnostics enrichment, correlation ids, endpoint-eviction forensics | deferred — observability follow-up; minimal file logger + log level land in Task 8 |
| skipLibCheck no-skipLibCheck baseline snapshot | deferred — upgrade-runbook artifact |
| 28 minor findings | deferred — see the review report's minors list |
