# State-root ownership

- **Status:** accepted and implemented
- **Date:** 2026-07-12
- **Branch:** `feat/architectural-foundation`
- **Supersedes:** machine-wide singleton wording in invariants I-2 and I-3

## Context

Expand can select its data directory globally through `--data-dir`. The selected directory determines the SQLite database, endpoint file, logs, and every other persistent backend artifact. Treating the backend as a machine-wide singleton conflicts with that capability: two explicitly selected state roots are intentionally isolated and may operate at the same time.

The previous discovery design also did not prove runtime uniqueness. A per-root `server.json.lock` prevents cooperating clients from starting the same backend concurrently, but it is released once startup finishes. It cannot reject a second manually launched backend that targets the same directory.

## Decision

The normalized absolute data directory is the identity of a state root. `makeAppContext` resolves the selected directory before deriving its database, endpoint, and log paths. Different state roots may host independent backends concurrently; one state root may have at most one live backend.

Invariant I-1 owns the static construction boundary: only `apps/server` may construct the backend `AppLayer`, and frontends remain clients. The backend enforces runtime uniqueness by acquiring `<state-root>/backend.lock` after default-home migration and before the logger, database, or `AppLayer` starts. It holds that lease for its entire scoped lifetime.

`backend.lock` stores a PID and an unguessable ownership token. The raw acquisition API rejects a live owner immediately. Server startup treats that evidence conditionally: an advertised live owner rejects the newcomer, while an endpoint-absent live owner is allowed a bounded four-second shutdown handoff. The newcomer polls until the prior owner releases and acquires only afterward, so the leases never overlap. Endpoint presence alone does not block acquisition because a stale endpoint without a live lifetime owner is replaceable. A dead owner may be reclaimed only when the record is valid and the claim still names the same owner and filesystem inode. An incomplete, malformed, replaced, or concurrently changing record fails closed without entering the handoff wait. Release removes the lock only when the current PID and token still match the lease, so an old finalizer cannot delete a replacement owner's lock.

Client coordination remains separate. Each root has one `server.json.lock`; its exclusive creation selects one cooperating client to invoke `spawnBackend`, while the others await that root's endpoint. Stale spawn locks are recoverable by the existing age and dead-PID policy. This lock coordinates startup but does not establish backend lifetime ownership.

Each state root also has one `server.json` endpoint file containing the URL, token, PID, and protocol version for that root's live backend. Clients derive discovery, spawn-lock, and backend arguments from the same `AppContext`, so callers targeting one root converge while callers targeting different roots proceed independently.

Invariant I-4 is evaluated per backend and therefore per state root. Closing the last client connected to one root shuts down only that root's backend, removes its endpoint, and releases its lifetime lock. Clients connected to another root are unaffected.

## Consequences

- Multiple isolated state roots are an explicit supported topology.
- Two live backends cannot intentionally share one root, even when launched outside client discovery.
- `backend.lock` is the authoritative runtime ownership record; `server.json.lock` is only client spawn coordination; `server.json` is only endpoint discovery.
- Invalid ownership evidence is preserved for diagnosis instead of being deleted speculatively.
- Review and architecture fitness tests must describe I-2 and I-3 per state root rather than per machine.
