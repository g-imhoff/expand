# Architectural invariants

Rules that must hold regardless of how the codebase evolves. Each entry
states the rule, why it matters, and how it is enforced.

A rule listed here is **not a guideline**. It is a load-bearing assumption
that other parts of the system rely on. Relaxing a rule requires an
explicit architecture decision, not a code-review judgment call.

---

## I-1. CLI client isolation

**Rule.** Source files under `backend/cli/**` must never import from any
server-only module. The CLI is a thin RPC client over WebSocket and the
only legitimate way for it to interact with backend state is to send a
command to the running `yodea` backend.

**Forbidden import sources** from `backend/cli/**`:

- `backend/server/**`
- `backend/application/**`
- `backend/domain/**`
- `backend/features/**`
- `backend/infrastructure/**`
- `backend/db/**`
- `backend/services/**`
- `backend/composition/**`

**Allowed import sources** from `backend/cli/**`:

- `backend/shared/**` — RPC contracts (Effect Schema) and shared utilities.
- `backend/lib/**` — low-level helpers genuinely shared with the server.
- External npm packages.

**Permitted exception.** `backend/cli/commands/server.ts` is the
`yodea server` subcommand wrapper. It is the *only* CLI file allowed to
import from `backend/composition/**`, and only to start the backend. Keep
this file as small as possible — ideally a single named import and a
function call.

**Why this matters.** The CLI binary and the backend live in the same
artifact, so the import graph is the only thing physically preventing the
CLI from instantiating a backend in-process. If a `backend/cli/**` file
imports a server module, every `yodea <command>` invocation builds its own
Effect AppLayer with its own event bus, its own SQLite handle, and its own
spawned ACP subprocesses — completely disconnected from any backend that
is already running. The consequences:

- Agents update their private SQLite. The desktop UI never sees it.
- Two parallel ACP subprocesses fight over the same provider session.
- Cold-start cost on every CLI call (booting Effect, opening SQLite, etc.).
- Subtle data divergence that only surfaces under multi-client load.

This is precisely the architecture this design was created to avoid.

**Enforcement.** An architectural-fitness test must verify the rule on
every CI run. The recommended approach is `dependency-cruiser` configured
with a forbidden rule named `cli-client-must-not-import-server`, wrapped
in a vitest test under `test/architecture/`. The test file must carry a
"DO NOT MODIFY" header and be referenced from CODEOWNERS so that any
attempt to relax the rule triggers architecture-owner review.

The test is part of the **specification**, not the implementation. It
should be treated like a contract clause: a change to it is a change to
the system's guarantees.

---

## I-2. One AppLayer per machine

**Rule.** At most one process per user environment may host the Effect
`AppLayer`. That process is started by `yodea server` and is the only
container that owns the domain event bus, the SQLite event log, the ACP subprocess
pool, and the typed service implementations. Every other process (desktop
renderer, CLI client, future web client) is a frontend that connects to
this single backend over WebSocket.

**Why this matters.** The domain event bus broadcasts events in-memory; SQLite holds
the canonical state; ACP subprocesses are stateful provider sessions.
Duplicating any of these into a second process desynchronizes the system
silently.

**Enforcement.** Mechanically implied by I-1 if I-1 holds. The discovery
file (see I-3) is the runtime mechanism that makes multiple frontends
converge on the same backend instance.

---

## I-3. Single discovery file

**Rule.** The backend writes its endpoint (`url`, `token`, `pid`,
`protocolVersion`) to one well-known file on startup and removes it on
clean shutdown. Frontends consult this file before opening any connection.

**Why this matters.** Without a shared rendezvous point, frontends cannot
coordinate to share a backend, and I-2 is unenforceable in practice.
Docker, Tailscale, and most local daemons use the same pattern for the
same reason.

**Enforcement.** Specification-only at the architecture level. The
implementation detail (path, locking strategy, stale-entry detection)
lives in the discovery component of each frontend.

---

## I-4. Server lifetime: zero-connection shutdown

**Rule.** The backend tracks active WebSocket connections. Once the first
connection has been established, the connection count must never return to
zero while the server is intended to stay alive. If the count reaches
zero, the server shuts itself down immediately — removes the endpoint
file, closes SQLite, interrupts ACP subprocesses, and exits.

There is no grace period and no idle timeout. Zero means dead.

**Lifecycle.**

1. A frontend (Desktop or CLI) finds no running server via the endpoint
   file and spawns `yodea server`.
2. The server starts, writes the endpoint file, and waits for its first
   connection.
3. The spawning frontend connects. Connection count goes from 0 to 1.
   From this point, the rule is armed.
4. Other frontends may connect and disconnect freely. As long as at least
   one connection remains, the server stays alive.
5. The moment the last connection closes (count reaches 0), the server
   shuts down and removes the endpoint file.
6. The next frontend that needs a server repeats from step 1.

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
For rapid CLI command sequences (e.g., an agent issuing several `yodea`
calls), the calling process should keep its WebSocket connection open
for the duration of its work, not reconnect per command.

**Why lifetime is not tied to the spawner.** The process that ran
`yodea server` (typically the first frontend) may exit while other
frontends are still connected. The server does not care who spawned it —
only how many connections are active. This prevents the "Desktop
launched the server, CLI outlives it" class of bugs.

**Enforcement.** Specification-only at the architecture level. The
implementation uses the server's in-memory connection count (e.g., an
Effect `Ref<number>`) — no file-based counters, no external coordination.

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
