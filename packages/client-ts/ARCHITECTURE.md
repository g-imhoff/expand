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
                 RuntimeAdapter (Node)
```

`RuntimeAdapter` supplies Node WebSocket and process-spawn behavior.
`ClientSession` owns the changing connection epoch. `ProjectClient` and
`ServerClient` are typed, session-backed facades. The optional sync controller
converts lists and sequenced events into application-owned snapshots without
depending on React, Zustand, Electron, or another UI runtime.

## Backend discovery and acquisition

`acquireClient` first finds or starts the backend. `readEndpoint` accepts an
endpoint descriptor only when it decodes, uses the current protocol version,
and names a live process. If there is no usable endpoint, the root-specific
spawn-lock protocol elects one process to start the backend while other clients
wait. Lock publication and removal use record, token, and inode evidence so a
delayed owner cannot delete a replacement lock. Endpoint polling runs every 100
milliseconds and has a 30-second startup deadline.

The acquisition and session layers leave `FileSystem`, `Path`, `Crypto`,
`AppContext`, and `ProcessControl` explicit. The Node `ProcessServices.layer`
provides the platform and process capabilities while the application provides
the data-root context.

After discovering an endpoint, acquisition builds the adapter's WebSocket
protocol layer, creates the typed Expand RPC client, and drains `Connect()`
until the server confirms presence. The presence handshake has a three-second
deadline. A stale endpoint is removed and acquisition is retried up to three
times. Scope closure tears down the socket and its supervised fibers.

The Node adapter injects `ws` into Effect's WebSocket layer, uses NDJSON RPC
serialization, and starts its required backend command with
`child_process.spawn`. The child is unreferenced; readiness is determined by
endpoint discovery rather than the spawn call.

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

Every raw transport attempt has independent disconnect, publication, and
serialization state. A stale attempt cannot invalidate or prevent publication
of a later healthy retry. Only the attempt published as the active epoch may
clear the current client and publish `"reconnecting"`. Publication and
disconnect are serialized so a connection that drops during acquisition is
never exposed as current.

The disconnect hook invalidates the current epoch before publishing
`"reconnecting"`. Commands started during reconnection wait for the next
client. The reconnect loop acquires a new epoch with capped exponential
backoff. Scope closure clears the current epoch, publishes `"disconnected"`,
and interrupts pending retry work.

## Session-backed typed facades

`ProjectClient` and `ServerClient` are thin typed APIs. Each request reads
`session.current`, then delegates to the corresponding RPC method. This makes a
long-lived facade stable while the underlying connection changes.

`ProjectClient` exposes project commands, `list`, and `events`. `ServerClient`
currently exposes `health`. `ClientLayer(adapter)` provides both facades and
their shared session; the scoped facade layers provide one facade with its own
session when that is all a host needs.

The facades do not retain project data or update application state. A successful
mutation response is never applied optimistically by the SDK.

## Framework-neutral project synchronization

`@expand/contracts/project-sync` is safe to use in a renderer because it imports
only contracts and Effect. It has no client transport, Node, Electron, React, or
Zustand dependency.

`runProjectSync(source, sink)` consumes:

- a status stream,
- a list effect returning `{ projects, seq }`,
- an events function accepting `{ fromSeq }`, and
- Effect-valued sink functions for status and complete snapshots.

For every connected epoch it performs:

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
sequence with the fresh authoritative result before replaying from its sequence.

A failed list or event stream, and a clean event-stream termination, both move
the sink to `"reconnecting"` and start a complete list-and-events retry loop
with capped backoff. The first successful fresh snapshot restores
`"connected"`. Status-stream failure remains in the `runProjectSync` error
channel so the owner of the synchronization fiber can observe it.
Sink failures propagate to that owner immediately and do not enter the source
retry schedule.

## Application ownership

### Desktop

The Electron main process hosts `ClientSession`, `ProjectClient`, and
`ServerClient`, then exposes the relevant RPC surface across the message-port
boundary. The renderer builds a renderer-safe sync source and writes snapshots
into a boot-scoped Zustand store. Renderer boot forks synchronization in scope,
races its first snapshot against early fiber failure, mounts after the first
snapshot, and then joins the sync fiber. Later status-stream failure therefore
reaches the outer supervised boot owner, which logs the failure and renders the
boot error. Scope teardown interrupts synchronization. Main-process port bridge
fibers are separately supervised and interrupted on supersession, navigation,
or close.

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
- `@expand/client-ts/adapters/node` exports the Node platform seam.
- `@expand/contracts/project-sync` exports `runProjectSync` and its framework-
  neutral source, sink, snapshot, and status types.

Acquisition, spawn-lock, transport construction, and supervision helpers remain
internal. Dependency-cruiser enforces scoped client entrypoints, and package
exports prevent deep imports from becoming compatibility surface.
