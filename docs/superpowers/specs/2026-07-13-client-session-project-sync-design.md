# Client Session and Project Synchronization Design

## Context

`@expand/client-ts/project` currently exports `ProjectStore`, a long-lived Effect service that combines backend discovery, connection lifecycle, reconnect behavior, typed project commands, an event-sourced project collection, connection status, and a callback subscription bridge.

That service is consumed directly by the TUI and by the Electron main process. The desktop renderer then builds a second `RendererProjectStore` from the main process RPC surface and copies it again into an `AppHandle` snapshot for React. The CLI already uses the stateless `ProjectClient` facade.

The shared `ProjectStore` obscures the boundary between connection infrastructure and application state. It also makes UI clients depend on an Effect-specific state container even when their native state model is different. In desktop, the duplicated main/renderer projections create a reconnect gap: the main projection can replace its snapshot after reconnect without emitting an event that makes the renderer replace its own snapshot.

## Decision

Remove the public `ProjectStore` abstraction and delete `packages/client-ts/project/store.ts`.

Replace its mixed responsibilities with three explicit layers:

1. `ClientSession` owns discovery, backend acquisition, connection status, reconnect, and access to the current RPC client.
2. `ProjectClient` owns typed project RPC operations, including list and event streaming, and delegates them through `ClientSession`.
3. `ProjectSync` is a framework-neutral synchronization controller in the renderer-safe `@expand/contracts/project-sync` module. It consumes an injected project RPC-shaped source and publishes atomic project snapshots to a client-owned sink. It is not an application store and exposes no `SubscriptionRef`, React hook, or Zustand API.

Application state is owned by each application:

- desktop renderer: a boot-scoped vanilla Zustand store;
- TUI: React-local state managed by its project hook;
- CLI: no reactive project state.

This is a breaking replacement. There is no deprecated `ProjectStore` alias or compatibility layer.

## Goals

- Remove shared application-state ownership from `client-ts`.
- Preserve backend discovery, automatic reconnect, connection status, and scoped cleanup as reusable client infrastructure.
- Preserve race-free, sequence-aware project synchronization without duplicating the algorithm in every client.
- Make desktop project state idiomatic Zustand state created once per renderer boot.
- Make TUI project state local to the TUI React tree.
- Keep CLI commands stateless.
- Fix desktop resynchronization after the upstream backend reconnects.
- Preserve existing domain error types and non-optimistic mutation semantics.
- Update exports, tests, documentation, and architecture checks so `ProjectStore` is fully absent.

## Non-goals

- Optimistic project mutations.
- Persisting client-side application state.
- Changing project domain contracts or backend event semantics.
- Replacing Effect in transport, session, or RPC infrastructure.
- Adding Zustand to the TUI or CLI.
- Redesigning unrelated desktop UI state such as the command palette.

## Alternatives considered

### Rename `ProjectStore` to `ProjectSession`

This is mechanically small, but it leaves project collection state, UI subscriptions, commands, and connection lifecycle in one SDK service. It changes terminology without correcting ownership and is rejected.

### Client-specific stores with duplicated synchronization

Desktop could implement the full sequence algorithm in Zustand and TUI could implement it independently in a hook. This gives each application complete ownership, but duplicates reconnect, replay, stale-event rejection, and bootstrap logic. It is rejected because protocol correctness should have one reusable implementation.

### Session infrastructure plus framework-neutral synchronization

This design separates transport lifecycle, domain RPCs, synchronization, and application state. It preserves reuse without prescribing a state framework and is selected.

## Client session

`ClientSession` is a connection-level service at the package root. It replaces the connection lifecycle currently embedded in `ProjectStore`.

Its responsibilities are:

- discover or spawn the backend using the configured `RuntimeAdapter`;
- acquire the first authenticated RPC connection before its layer succeeds;
- publish `connected`, `reconnecting`, and `disconnected` status transitions;
- invalidate a disconnected RPC client so new operations do not use a stale session;
- reacquire a backend and publish a new live client after transient failure;
- stop all connection and retry fibers when its scope closes.

The session publishes connection epochs, not project state. A connection epoch provides the current `ExpandRpcClientApi` for the lifetime of one upstream connection. Domain clients use the current epoch for request/response operations. Long-lived consumers observe epoch changes and recreate streams against the new client.

Initial acquisition failure remains `BackendUnavailable`. After the first successful connection, transient failures do not fail the managed application runtime; the session enters `reconnecting` and retries with the existing bounded-backoff policy.

`ClientLayer(adapter)` is rebuilt on top of one shared `ClientSessionLayer(adapter)` so `ProjectClient` and `ServerClient` use the same connection. Standalone domain layers use the same session implementation rather than acquiring independent raw clients.

## Project client

`ProjectClient` retains the existing command methods and `list`. It gains the project event operation required by synchronized clients.

The client surface contains:

- `create`
- `rename`
- `changeDirectory`
- `archive`
- `restore`
- `setMetadata`
- `delete`
- `list`
- `events({ fromSeq })`

Request/response operations wait for or use the current connected epoch. Their domain error channels remain unchanged. Transport interruption continues to surface as `RpcClientError` to the caller.

`events({ fromSeq })` opens the backend event stream for one connection epoch and delegates `fromSeq` to the backend. It does not emulate replay by filtering a process-local live stream. If its epoch disconnects, the stream terminates; `ProjectSync` responds by awaiting the next connected epoch and resynchronizing.

## Project synchronization

`ProjectSync` is a structural, framework-neutral controller implemented by the exported `runProjectSync` function in `@expand/contracts/project-sync`. Its source is an injected interface with list, events, and connection-state capabilities. This allows the same controller to work with `ProjectClient` plus `ClientSession` in the TUI and the port-backed `ProjectRpc` in the desktop renderer without weakening Electron's rule that forbids renderer imports from `client-ts`.

Its sink receives atomic values shaped as:

```ts
interface ProjectSnapshot {
  readonly projects: ReadonlyArray<Project>
  readonly seq: number
}
```

The controller owns only ephemeral synchronization machinery: the active cursor, the current connection epoch, and any scoped fibers. It does not expose a readable state container.

For each connected epoch it performs this cycle:

1. Read `ProjectList({ includeArchived: true })`, obtaining an atomic `{ projects, seq }` snapshot.
2. Publish the snapshot to the client sink in one operation.
3. Open `Events({ fromSeq: snapshot.seq })`.
4. For each event with `seq` greater than the current cursor, derive the next project array with `Project.foldList`, advance the cursor, and publish the new atomic snapshot.
5. Ignore duplicate or stale events whose sequence is not greater than the cursor.
6. When the event stream or connection epoch ends, retain the last published snapshot, report reconnecting status, await the next epoch, and restart from a fresh list snapshot.

List-then-events is race-free because the backend event operation replays every durable event strictly after `fromSeq`. The desktop main bridge must therefore forward replay to the upstream backend rather than filter a live local hub.

The sink callback is required to be total. A desktop Zustand `setState` call and a TUI React state setter satisfy this contract.

## Desktop architecture

### Main process

The main runtime hosts `ClientSession`, `ProjectClient`, and `ServerClient`; it no longer hosts a project collection.

Desktop RPC handlers forward project commands and list requests to `ProjectClient`. The `Events` handler opens the current upstream event stream with the caller's `fromSeq`. The `Connect` handler reflects `ClientSession` status. `Health` delegates to `ServerClient` while connected.

The bridge must preserve the upstream replay contract and allow a renderer event stream to terminate when its upstream epoch disconnects. The renderer synchronization controller then resynchronizes through list plus replay on the next epoch.

### Renderer process

Renderer boot creates one `zustand/vanilla` store and provides it through React context. It is not a module-global singleton because its lifetime and cleanup are tied to the boot-scoped MessagePort and Effect resources.

The store owns:

- `projects`;
- `seq`;
- connection/synchronization status.

Project command functions remain RPC-backed actions. Per-dialog mutation pending and error state remains in the existing mutation hooks rather than becoming global store state.

`ProjectSync` writes snapshots and status directly into Zustand. React reads the store through selector hooks. This removes `RendererProjectStore`, its `SubscriptionRef`, the `AppHandle` snapshot/listener mirror, and the extra `useSyncExternalStore` adapter.

Mutations do not change `projects` optimistically. Successful responses resolve callers, while project state changes arrive through synchronized events or a reconnect snapshot.

## TUI architecture

The TUI runtime provides session-backed `ProjectClient` and `ProjectSync` dependencies instead of `ProjectStore`.

The TUI `useProjects` hook owns its project array and error state with React. On mount it starts the scoped synchronization controller and sends each atomic snapshot to the hook state. On unmount it interrupts the controller. Mutation functions call `ProjectClient` directly and preserve the existing error rendering behavior.

TUI selection and overlay reconciliation continue to derive from the hook-owned project array. Zustand is not introduced.

## CLI architecture

The CLI retains its current stateless `ProjectClient` and `ServerClient` command model. Its `ClientLayer` is session-backed, so the CLI participates in the new connection boundary without acquiring project state.

No CLI command subscribes to `ProjectSync`. Existing command behavior, output, and domain error handling remain unchanged.

## Error and lifecycle behavior

- Initial backend acquisition failure prevents the application layer from building and returns `BackendUnavailable`.
- A transient disconnect after initial acquisition changes status to `reconnecting` and retains the latest client-owned project snapshot.
- Commands attempted during reconnect wait for the next usable epoch or fail according to their caller's interruption or timeout.
- Event stream transport failures trigger resynchronization; they do not clear projects.
- A fresh list snapshot atomically replaces the prior snapshot after reconnect.
- Domain validation and conflict errors remain typed and are never converted to synchronization failures.
- Scope closure interrupts session retries, event streams, synchronization controllers, and desktop port resources.

## Public API and file layout

The migration introduces connection-level session files under `packages/client-ts` and the pure synchronization controller at `packages/contracts/project-sync.ts`.

The public surfaces export:

- `ClientSession`, `ClientSessionLayer`, `ClientSessionApi`, and `ConnectionStatus` from `@expand/client-ts`;
- `ProjectClient`, `ProjectClientLayer`, and `ProjectClientApi` from `@expand/client-ts/project`;
- `runProjectSync`, `ProjectSyncSource`, `ProjectSyncSink`, and `ProjectSnapshot` from `@expand/contracts/project-sync`;
- existing project contract vocabulary from `@expand/client-ts/project`.

The package no longer exports or contains `ProjectStore`, `ProjectStoreLayer`, `ProjectStoreApi`, `subscribeRef`, or `project/store.ts`.

Desktop's Zustand implementation remains under the desktop projects feature. TUI synchronization wiring remains under `apps/tui`.

## Testing strategy

### Client session

- first acquisition and typed initial failure;
- connected/reconnecting/connected transitions;
- stale client invalidation;
- command use after reacquisition;
- shared session between project and server clients;
- scoped cleanup and retry interruption.

### Project synchronization

- initial snapshot publication;
- replay of events after the list cursor;
- duplicate and stale sequence rejection;
- atomic cursor/project publication;
- changes occurring between list and event subscription are replayed;
- disconnect retains the last snapshot;
- reconnect performs a fresh list and converges after missed external changes;
- controller interruption stops delivery.

### Desktop

- boot-scoped Zustand store creation and selector subscriptions;
- project RPC action wiring and typed errors;
- list/event synchronization through the MessagePort bridge;
- a full renderer-through-main reconnect regression proving missed external changes appear after resnapshot;
- removal of the SubscriptionRef/AppHandle mirror path;
- existing UI workflows for create, rename, directory, archive, restore, metadata, and delete.

### TUI and CLI

- TUI initial synchronization, live updates, reconnect convergence, cleanup, and mutation errors;
- existing TUI UI tests against the TUI-owned state boundary;
- existing CLI command and lifecycle tests through the session-backed client layer.

### Architecture and completion checks

- entrypoint tests assert the new exports and the absence of `ProjectStore`;
- repository search finds no production-source or public-documentation reference to `ProjectStore` or `ProjectStoreLayer`; migration specs and explicit negative export assertions are excluded;
- typechecking, lint, dependency architecture checks, relevant package tests, the full test suite, and desktop build all pass.

## Migration sequence

1. Introduce `ClientSession` and move reconnect responsibilities out of `ProjectStore` under tests.
2. Rebase `ProjectClient`, `ServerClient`, and `ClientLayer` on the shared session.
3. Introduce and test renderer-safe `ProjectSync` in `@expand/contracts/project-sync` with an injected source and sink.
4. Replace desktop main projection handlers and implement the renderer Zustand store.
5. Replace TUI `ProjectStore` usage with `ProjectClient` plus `ProjectSync` and React-local state.
6. Confirm CLI behavior through the session-backed layer.
7. Delete `ProjectStore`, obsolete bridges, obsolete tests, and all public/documentation references.
8. Run task reviews, whole-branch review, and fresh completion verification.
9. Fast-forward the completed branch into `feat/architectural-foundation`, preserving pre-existing working-tree changes through the authorized safety-stash procedure.

## Merge policy

Implementation occurs only in the isolated `feature/client-state-boundary` worktree. Commits remain small and task-focused.

At completion, the controller records the target checkout's dirty state, creates a named safety stash including untracked files if needed, fast-forwards `feat/architectural-foundation`, and restores the stash. Unrelated user changes are preserved. Stale hunks that only edit files deliberately deleted or replaced by this migration are discarded during conflict resolution; all other conflicts are resolved in favor of preserving both the migration and the user's work.
