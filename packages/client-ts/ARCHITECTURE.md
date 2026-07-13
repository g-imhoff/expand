# `@expand/client-ts` architecture

This document describes the client connection boundary, typed facades, and the
framework-neutral project synchronization controller. The central rule is that
the SDK owns connectivity while each application owns its presentation state.

## Mental model

```text
Desktop Zustand | TUI React state | stateless CLI
                         ↑
        @expand/contracts/project-sync
                         ↑
          ProjectClient | ServerClient
                         ↑
                    ClientSession
                         ↑
       acquireClient and Expand RPC transport
                         ↑
             RuntimeAdapter (Bun | Node)
```

`RuntimeAdapter` supplies platform-specific WebSocket and process-spawn
behavior. `ClientSession` owns the changing connection epoch. `ProjectClient`
and `ServerClient` are typed, session-backed facades. The optional sync
controller converts lists and sequenced events into application-owned
snapshots without depending on React, Zustand, Electron, or another UI runtime.

## Backend discovery and acquisition

`acquireClient` first finds or starts the backend. A valid endpoint descriptor
must decode, use the current protocol version, and point at a live process. If
there is no usable endpoint, the spawn-lock protocol elects one process to start
the backend while other clients wait for the endpoint.

After discovering an endpoint, acquisition builds the adapter's WebSocket
protocol layer, creates the typed Expand RPC client, and drains `Connect()` until
the server confirms presence. A stale endpoint is removed and acquisition is
retried. Scope closure tears down the socket and its supervised fibers.

The Bun and Node adapters share the NDJSON RPC protocol but use their platform's
socket and spawn primitives. Both are isolated behind adapter entrypoints so
consumers do not load the other platform's dependencies.

## `ClientSession`

`ClientSessionLayer(adapter)` starts one scoped reconnect loop and waits for the
first successful epoch before providing the service. Failure before that first
connection surfaces as `BackendUnavailable`.

The public session API is:

- `status`, a `SubscriptionRef` with `"connected"`, `"reconnecting"`, and
  `"disconnected"` states.
- `current`, an effect that waits until an active RPC epoch exists and returns
  it.
- `epochs`, a stream that emits each active epoch.

The disconnect hook invalidates the current epoch before publishing
`"reconnecting"`. This ordering prevents commands from observing a stale client
after the status transition. The reconnect loop acquires a new client with
capped exponential backoff. Scope closure clears the current epoch, publishes
`"disconnected"`, and interrupts pending retry work.

## Session-backed typed facades

`ProjectClient` and `ServerClient` are thin typed APIs. Each request reads
`session.current`, then delegates to the corresponding RPC method. This makes a
long-lived facade stable while the underlying connection changes.

`ProjectClient` exposes project commands, `list`, and `events`. `ServerClient`
currently exposes `health`. `ClientLayer(adapter)` provides both facades and
their shared session; the scoped facade layers provide one facade with its own
session when that is all a host needs.

The facades do not retain project data or update application state. In
particular, a successful mutation response is not applied optimistically by the
SDK.

## Framework-neutral project synchronization

`@expand/contracts/project-sync` is safe to use in a renderer because it imports
only contracts and Effect. It has no client transport, Node, Electron, React, or
Zustand dependency.

`runProjectSync(source, sink)` consumes:

- a status stream,
- a list effect returning `{ projects, seq }`,
- an events function accepting `{ fromSeq }`, and
- sink functions for status and complete snapshots.

For every `"connected"` epoch it performs:

```text
list()
  → sink.snapshot(fresh list)
  → events({ fromSeq: fresh seq })
  → discard seq <= current seq
  → fold each newer event
  → sink.snapshot({ projects, seq })
```

Listing before subscribing is race-free because `Events({ fromSeq })` replays
all events committed after the returned list sequence. Projects and sequence
are stored and published as one snapshot, so observers cannot see a sequence
ahead of the project fold it represents.

Status changes interrupt the active event epoch before starting another one.
During `"reconnecting"`, the sink retains the last snapshot. The next
`"connected"` status performs another list and replaces both projects and
sequence with the fresh authoritative result. It does not merge the fresh list
with state retained from the failed epoch. Events are then replayed from the new
list sequence.

## Application ownership

### Desktop

The Electron main process hosts `ClientSession`, `ProjectClient`, and
`ServerClient`, then exposes the relevant RPC surface across the message-port
boundary. The renderer builds a renderer-safe sync source and writes snapshots
into a Zustand store. Each renderer boot creates an independent store, and
snapshot updates set projects and sequence together.

### TUI

The TUI hosts `ClientLayer` directly. Its `useProjects` hook runs the shared sync
controller and writes snapshots into React state. Commands go through
`ProjectClient`; only synchronized lists and events update visible project
state. Unmounting interrupts the synchronization fiber.

### CLI

The CLI is stateless. Commands use the session-backed typed facades, await one
request, format the result, and exit. It has no synchronization controller or
long-lived project state container.

## Public surface

- `@expand/client-ts` exports the connection boundary: `ClientSession`,
  `ClientSessionLayer`, `ClientLayer`, `ConnectionStatus`, `withClient`, adapter
  types, connection errors, discovery helpers, and stream vocabulary.
- `@expand/client-ts/project` exports `ProjectClient`, `ProjectClientLayer`, its
  API type, and project contract vocabulary.
- `@expand/client-ts/server` exports `ServerClient`, `ServerClientLayer`, and its
  API type.
- `@expand/client-ts/adapters/bun` and `@expand/client-ts/adapters/node` export
  the platform seams.
- `@expand/contracts/project-sync` exports `runProjectSync` and its framework-
  neutral source, sink, snapshot, and status types.

Acquisition, spawn-lock, transport-construction, and supervision helpers remain
internal. Dependency-cruiser enforces scoped client entrypoints, and package
exports prevent deep imports from becoming compatibility surface.
