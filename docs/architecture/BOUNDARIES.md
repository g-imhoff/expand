# Architectural invariants

Rules that must hold regardless of how the codebase evolves. Each entry
states the rule, why it matters, and how it is enforced.

A rule listed here is **not a guideline**. It is a load-bearing assumption
that other parts of the system rely on. Relaxing a rule requires an
explicit architecture decision, not a code-review judgment call.

---

## I-1. Frontend isolation

**Rule (generalized).** No frontend — `apps/cli/cli`, `apps/tui`,
`apps/desktop` — and no shared client code (`packages/client-ts`) may
import backend-internal modules (`apps/server/**`). Frontends depend ONLY
on the pure contract (`packages/contracts`) and the connection brain
(`packages/client-ts`). Additionally, the Electron **renderer and
preload** (`apps/desktop/src/{renderer,preload}`) may not import
`packages/client-ts` or the Electron **main** process; they reach the
backend exclusively through the typed `ExpandRpcs` contract carried over
the `MessagePort`. The preload exposes exactly the surface derived from
the `ExpandIpc` registry (`apps/desktop/src/shared/ipc/channels.ts`,
rendered by `packages/electron-ipc` — see the ADR
`docs/superpowers/specs/2026-06-12-typed-ipc-framework-design.md`); no
hand-written bridge code. Registry channels are restricted to
**desktop-shell concerns** (port bootstrap, window lifecycle); all
domain/backend interaction flows exclusively through `ExpandRpcs` over the
MessagePort. The `event` channel kind may carry only pre-port bootstrap
messages — domain push is stream RPCs on the port. Enforced by
`.dependency-cruiser.cjs` (`renderer-must-not-import-client-ts`,
`electron-ipc-package-isolated`, `shared-ipc-stays-pure`,
`preload-imports-allowlist`) + `test/architecture/i1-cli-isolation.test.ts`
+ `test/architecture/ipc-boundary.test.ts`.

The original CLI-only statement (kept below for the rationale it documents)
is now a special case of this rule: the CLI is a thin RPC client over
WebSocket and the only legitimate way for any frontend to interact with
backend state is to send a command to the running `expand` backend.

**Forbidden import sources** from every frontend (`apps/cli/cli/**`,
`apps/tui/**`, `apps/desktop/src/**`) and from `packages/client-ts/**`:

- `apps/server/**` — the entire backend: composition root, db, domain,
  application, http transport, rpc-handlers, endpoint-file,
  connection-tracker.

**Allowed import sources** from frontends:

- `packages/contracts/**` — RPC contracts (Effect Schema) and shared
  schema types.
- `packages/client-ts/**` — discovery, RPC client, project store
  (except from the Electron renderer/preload, which reach the backend
  only through the MessagePort seam).
- External npm packages.

**No permitted exception.** The former `expand server` subcommand wrapper
(`apps/cli/cli/commands/server.ts`, which imported the backend
composition root) was removed when the backend gained its dedicated
entrypoint `apps/server/main.ts`; `test/architecture/server-app-split.test.ts`
asserts the file and its dependency-cruiser exception stay gone.

**Why this matters.** The CLI client (`dist/expand`) and the backend
(`dist/expand-server`) ship as separate binaries, and the import graph is
what physically prevents any frontend from instantiating a backend
in-process. If a frontend file
imports a server module, every `expand <command>` invocation builds its own
Effect AppLayer with its own event bus, its own SQLite handle, and its own
spawned ACP subprocesses — completely disconnected from any backend that
is already running. The consequences:

- Agents update their private SQLite. The desktop UI never sees it.
- Two parallel ACP subprocesses fight over the same provider session.
- Cold-start cost on every CLI call (booting Effect, opening SQLite, etc.).
- Subtle data divergence that only surfaces under multi-client load.

This is precisely the architecture this design was created to avoid.

**Enforcement.** An architectural-fitness test must verify the rule on
every CI run. The implementation is `dependency-cruiser` configured with
the forbidden rules `frontends-must-not-import-backend`,
`renderer-must-not-import-client-ts`, `electron-ipc-package-isolated`,
`shared-ipc-stays-pure`, and `preload-imports-allowlist`, wrapped in
vitest tests under `test/architecture/` (`i1-cli-isolation.test.ts` and
`ipc-boundary.test.ts`). The cruiser's
`exclude` patterns are segment-anchored and pinned by
`test/architecture/depcruise-exclude.test.ts` so no source file whose
name merely contains "test" can silently drop out of the cruise. The
test file must carry a "DO NOT MODIFY" header and be referenced from
CODEOWNERS so that any attempt to relax the rule triggers
architecture-owner review.

The test is part of the **specification**, not the implementation. It
should be treated like a contract clause: a change to it is a change to
the system's guarantees.

---

## I-2. One AppLayer per state root

**Rule.** At most one live backend process per normalized absolute state
root may host the Effect `AppLayer`. That process is the dedicated backend
entrypoint (`apps/server/main.ts`, shipped as `dist/expand-server`) and is
the only container for that root's domain event bus, SQLite event log, ACP
subprocess pool, and typed service implementations. Every other process
targeting that root is a frontend that connects over WebSocket. Different
state roots are intentionally isolated and may host independent backends
concurrently.

**Why this matters.** The domain event bus broadcasts events in memory,
SQLite holds canonical state, and ACP subprocesses are stateful provider
sessions. Duplicating these into two processes that share one state root
silently desynchronizes the system. Separate roots do not share those
resources and therefore do not require a machine-wide singleton.

**Enforcement.** I-1 and
`test/architecture/backend-ownership.test.ts` statically confine the backend
composition root and its stateful services to `apps/server`. For either
channel's default root, startup first acquires the shared external
`<home>/.expand-locks/legacy-migration.lock`, performs migration, fails closed
with the recoverable legacy or staging path if required data remains unresolved,
then acquires `<state-root>/backend.lock`; only after that lifetime lease exists
does it release the migration guard. Non-default roots bypass the guard and
migration. A live migration-guard handoff is bounded to four seconds and fails
closed if the owner never releases. The root lease is acquired before the logger, database, or `AppLayer`
starts and is held for the backend's scoped lifetime. An advertised live owner
rejects a second backend. If the live owner has already removed its endpoint
while finishing shutdown, startup waits up to four seconds for that owner to
release the lease and acquires only after release, so no two backends overlap. A dead owner is
reclaimed only when its valid PID/token record remains the same owner and
filesystem inode; malformed, incomplete, replaced, or changing ownership
evidence fails closed without entering the handoff wait. Release removes only
the matching PID/token lease. The derived client spawn lock in I-3 coordinates
spawns but does not enforce backend lifetime ownership. The state-root lock
protocol is exercised by `apps/server/test/integration/state-root-lock.test.ts`
and compiled lifecycle certification; `npm run effect:audit` additionally
requires the lock, database, transport, listeners, and child processes to have
Effect-scoped ownership and interruption cleanup.

---

## I-3. One discovery file per state root

**Rule.** The backend writes its endpoint (`url`, `token`, `pid`,
`protocolVersion`) to `<state-root>/server.json` on startup and removes it
on clean shutdown. Frontends derive the same normalized state root through
`AppContext` and consult only that root's endpoint before connecting.

**Why this matters.** A per-root rendezvous point makes all frontends that
selected the same state converge on one backend while preserving intentional
isolation and concurrency between different roots.

**Enforcement.** Discovery, endpoint polling, the spawn lock, and the
backend spawn argument all derive from the same normalized `AppContext`.
The normalized default root uses the channel-specific external
`<home>/.expand-locks/expand[-dev].spawn.lock`, including when explicitly
selected; every non-default root uses `<state-root>/server.json.lock`.
Ownership-safe atomic publication selects one cooperating client to spawn while
the others wait and permits a contender to re-elect if the selected spawner
fails before advertising. Dead current and legacy owners are reclaimed only
through unchanged record and inode evidence; live, malformed, incomplete, or
changing evidence fails closed. The server's separate `backend.lock` remains
the authoritative runtime singleton for the root. Endpoint publication and
cleanup are exercised by
`apps/server/test/integration/endpoint-file.test.ts`; same-root convergence,
failed-owner takeover, deadline, and lock behavior are exercised by
`packages/client-ts/test/integration/find-or-spawn.test.ts` and
`packages/client-ts/test/integration/spawn-lock.test.ts`.

---

## I-4. Server lifetime: zero-connection shutdown

**Rule.** The backend for each selected state root tracks its own active
WebSocket connections. Once its first connection has been established, the
connection count must never return to zero while that backend is intended to
stay alive. If the count reaches zero, the backend shuts itself down
immediately — removes that root's endpoint file, closes its SQLite store,
interrupts its ACP subprocesses, releases `backend.lock`, and exits.

There is no grace period and no idle timeout. Zero means dead.

**Lifecycle.**

1. A frontend (Desktop or CLI) finds no running server for its selected
   state root via the endpoint file and spawns the backend binary
   (`dist/expand-server`; from source, `apps/server/main.ts`).
2. The server starts, writes the endpoint file, and waits for its first
   connection.
3. The spawning frontend connects. Connection count goes from 0 to 1.
   From this point, the rule is armed.
4. Other frontends targeting the same root may connect and disconnect
   freely. As long as at least one connection remains, the server stays alive.
5. The moment the last connection closes (count reaches 0), the server
   shuts down and removes the endpoint file.
6. The next frontend that needs that state root repeats from step 1.

**Example.**

```
t=0   CLI spawns server             connections: 0 (waiting)
t=0   CLI connects                  connections: 0 → 1 (rule armed)
t=1   Desktop connects              connections: 1 → 2
t=2   CLI finishes, disconnects     connections: 2 → 1 (server alive)
t=∞   Desktop stays connected       connections: 1     (server alive)
...
t=N   Desktop quits                 connections: 1 → 0 → shutdown
```

**Why no grace period.** A grace period adds a timer, a configurable
knob, and a class of "server lingered when it shouldn't have" bugs.
The simpler model is: if nobody is connected, nobody needs the server.
For rapid CLI command sequences (e.g., an agent issuing several `expand`
calls), the calling process should keep its WebSocket connection open
for the duration of its work, not reconnect per command.

**Why lifetime is not tied to the spawner.** The process that spawned
the backend (typically the first frontend) may exit while other frontends
targeting that root are still connected. The server does not care who
spawned it — only how many connections to that root are active. This
prevents the "Desktop launched the server, CLI outlives it" class of bugs.

**Enforcement.** `apps/server/connection-tracker.ts` owns the in-memory
connection state; there are no file-based counters or external coordination.
`apps/server/composition/app.ts` awaits that tracker, removes the endpoint,
and closes the HTTP transport through a one-second bounded graceful shutdown.
The transport and core resources are also attached to the enclosing Effect
scope so startup failure or interruption cannot bypass release; the bounded
transport close does not add a connection grace period or idle timeout.
`apps/server/test/unit/connection-tracker.test.ts`,
`apps/server/test/integration/endpoint-file.test.ts`, and
`apps/server/test/unit/harness.test.ts` exercise zero-connection signaling,
endpoint and transport cleanup, typed cleanup Causes, and resource release on
normal shutdown, failure, and interruption. Compiled lifecycle certification
runs through `npm run cert:cli:build`.

---

## Modifying these invariants

Each invariant is a constraint other parts of the system depend on. An
invariant may be modified only by:

1. Opening an architecture-decision document describing what changes and
   why.
2. Updating this file and the C4 model in the same commit.
3. Updating or replacing the corresponding enforcement test in the same
   commit.

A commit that touches an enforcement test without touching this document
should be rejected.
