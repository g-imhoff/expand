# Remove Legacy Home Migration

## Goal

Remove all startup behavior that relocates an old implicit data home. Every configured data directory, including the channel default, starts and remains an independent state root. Preserve the runtime invariant that only one backend process may own a given state root at a time.

## Context

The application has not reached production, so compatibility with the earlier `~/.expand/events.db` layout is unnecessary. A developer can delete obsolete local state and let the application create a fresh database under the selected root.

The current server startup path combines two concerns:

1. A compatibility migration from the earlier unscoped home into the selected channel default.
2. A `backend.lock` lease that prevents multiple backend processes from using the same state root.

Only the second concern remains required.

## Architecture

`AppContext` continues to normalize the selected `--data-dir` and derive its database, endpoint, log, and spawn-lock paths. Each distinct normalized data directory remains isolated.

At server startup, `main.ts` acquires `stateRootLockForStartup(paths.dataDir, paths.endpointFile)` inside the existing scoped program before constructing the file logger, opening SQLite, or starting the RPC server. The lease remains scoped to the server lifetime and is released during teardown.

The migration-specific `startupOwnership` orchestration layer is removed rather than retained as a one-line wrapper. Migration-only coordination-lock APIs are also removed from `state-root-lock.ts`; the per-root ownership APIs and their safety behavior remain.

## Removed Components

- `apps/server/migrate-default-home.ts`
- `apps/server/migrate-legacy-home.ts`
- `apps/server/startup-ownership.ts`
- Their migration and startup-ownership integration test files
- Migration-only coordination lock acquisition from `apps/server/state-root-lock.ts`
- Review-guide claims and reading instructions that describe legacy-home migration

## Preserved Ownership Behavior

The state-root lock must continue to:

- Create a private `backend.lock` inside each selected data directory.
- Reject a second live backend for the same normalized root.
- Allow backends for different normalized roots to coexist.
- Recover a dead owner's lock only after verifying stable ownership evidence.
- Refuse malformed or changing ownership evidence.
- Wait only for the bounded startup/shutdown handoff when a live owner has not advertised an endpoint.
- Reject promptly when a live owner has already advertised its endpoint.
- Release only the lease owned by the current process, including during scoped failure or shutdown.

## Startup Flow

The resulting server startup sequence is:

1. Resolve `AppContext`.
2. Acquire the selected root's startup-aware `backend.lock` lease.
3. Construct the logger and create the selected root if necessary.
4. Open the selected root's SQLite database and start the backend.
5. Release the lease when the server scope closes.

No startup step reads, moves, stages, or validates data in another root.

## Error Handling

Startup exposes only `StateRootLockError` for ownership failures. Legacy migration errors and recoverable staging paths no longer exist.

A contended, unsafe, or unreadable ownership record continues to fail closed. Removal of migration must not weaken lock acquisition or allow startup to proceed without a valid lease.

## Testing

Implementation follows a red-green cycle:

1. Add a production-entrypoint integration test asserting that an old `~/.expand/events.db` and marker remain untouched while the channel default starts with fresh state. Confirm this fails against the current migration behavior.
2. Remove the migration path and make that test pass.
3. Retain and run the state-root ownership suite covering same-root exclusion, different-root coexistence, stale recovery, live-owner handling, bounded handoff, scoped release, and replacement-owner safety.
4. Run server integration tests, contract path tests, architecture checks, type checking, linting, and the repository's full verification command.

## Non-Goals

- Migrating, copying, importing, or deleting any existing user data.
- Changing the default data-directory names.
- Removing client spawn convergence or its spawn lock.
- Allowing multiple backends to use one state root.
- Refactoring unrelated state-root locking internals.
