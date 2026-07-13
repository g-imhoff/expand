# `@expand/client-ts`

The Effect-native client SDK for the Expand backend. It discovers or starts the
backend, maintains a reconnecting RPC-over-WebSocket session, and exposes typed
project and server clients. Applications decide how, or whether, to retain
project state.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the connection and synchronization
internals.

## Install

`@expand/client-ts` is a workspace package inside the Expand monorepo:

```json
{ "dependencies": { "@expand/client-ts": "workspace:*" } }
```

## Entrypoints

| Import | Surface |
| --- | --- |
| `@expand/client-ts` | `ClientSession`, `ClientSessionLayer`, `ClientLayer`, `withClient`, adapter-independent connection types, and transport errors. |
| `@expand/client-ts/project` | The session-backed `ProjectClient` facade and project contract vocabulary. |
| `@expand/client-ts/server` | The session-backed `ServerClient` facade. |
| `@expand/client-ts/adapters/bun` or `@expand/client-ts/adapters/node` | Platform-specific socket and process adapters. |
| `@expand/contracts/project-sync` | The renderer-safe, framework-neutral `runProjectSync` controller and its source, sink, snapshot, and status types. |

The root does not re-export domain clients. Use their scoped entrypoints.

## Session-backed clients

`ClientSession` owns connection discovery, initial acquisition, disconnect
observation, and reconnect attempts. Its `status` reports `"connected"`,
`"reconnecting"`, or `"disconnected"`; `current` waits for the active RPC
epoch; and `epochs` emits each newly connected epoch.

`ClientLayer(adapter)` provides one shared session together with `ProjectClient`
and `ServerClient`. The facades delegate each operation through the session, so
commands issued after a reconnect use the current epoch.

```ts
import { Effect } from "effect"
import { BunServices } from "@effect/platform-bun"
import { ClientLayer } from "@expand/client-ts"
import { ProjectClient } from "@expand/client-ts/project"
import { makeBunAdapter } from "@expand/client-ts/adapters/bun"

const program = Effect.flatMap(ProjectClient, (client) =>
  client.list({ includeArchived: true })
).pipe(
  Effect.provide(ClientLayer(makeBunAdapter())),
  Effect.provide(BunServices.layer)
)

const snapshot = await Effect.runPromise(program)
```

Use `ProjectClientLayer(adapter)` or `ServerClientLayer(adapter)` when only one
facade is needed. Use `withClient(adapter, use)` for a scoped low-level call.

## Application-owned project state

Long-lived user interfaces compose their own state container with
`runProjectSync`. The controller accepts a source of connection status, lists,
and events, then publishes atomic `{ projects, seq }` snapshots to an
application-owned sink.

```ts
const source = {
  status: SubscriptionRef.changes(session.status),
  list: () => projects.list({ includeArchived: true }),
  events: ({ fromSeq }: { readonly fromSeq: number }) =>
    projects.events({ fromSeq })
}

yield* runProjectSync(source, {
  status: setStatus,
  snapshot: setSnapshot
})
```

Each connected epoch uses a race-free bootstrap:

1. Fetch a fresh list with its sequence number.
2. Publish that complete snapshot.
3. Start `Events({ fromSeq: snapshot.seq })`, which replays anything committed
   after the list.
4. Ignore duplicate or stale sequences and publish each newer fold atomically.

On `"reconnecting"`, the controller interrupts the old event epoch and retains
the last visible snapshot. When the session becomes connected again, it lists
again and replaces the old projects and sequence with that fresh authoritative
snapshot before replaying newer events. Reconnect is replacement, not a merge
with stale local state.

The controller also recovers when `list` or `Events` fails, or when `Events`
ends cleanly while the source still reports a connected session. It publishes
`"reconnecting"`, retries a complete list-and-events epoch with capped backoff,
and publishes `"connected"` after the fresh snapshot succeeds. A failure of the
source status stream is owner-visible instead: it fails `runProjectSync` so the
application supervising the synchronization fiber can surface the failure.

The applications deliberately choose different ownership models:

- Desktop stores synchronized snapshots and connection status in renderer-owned
  Zustand state.
- TUI stores synchronized snapshots in React state and interrupts the sync fiber
  when the component unmounts.
- CLI remains stateless: each command calls the typed facade and renders the
  response without maintaining a project replica.

Mutation responses are not an optimistic state source for desktop or TUI. Their
visible state changes only through a fresh list or sequenced server event.

## Backend command and adapters

Every SDK layer leaves `FileSystem` unprovided. Supply `BunServices.layer` or
`NodeServices.layer` in the host. Bun and Node/Electron consumers select their
adapter from the corresponding adapter entrypoint.

`makeNodeAdapter` requires a backend command. `makeBunAdapter` can use its
default, but applications can pass a command resolved by
`resolveBackendCommand`. The resolver honors `EXPAND_BACKEND_CMD` when it is a
JSON array of strings.

## Errors

Import transport errors from the root and domain errors from
`@expand/client-ts/project`:

- `BackendUnavailable` means initial backend discovery, startup, or connection
  failed. After initial acquisition, reconnecting is reflected by the session
  status.
- `RpcClientError` is the type for transport or protocol RPC failures.
- Project commands can fail with domain errors such as `ProjectNotFound`,
  `ProjectNameConflict`, `ProjectDirectoryInvalid`,
  `ProjectDirectoryConflict`, or `ProjectInvalidInput`.

```ts
import { Effect } from "effect"
import { ProjectClient, ProjectNameConflict } from "@expand/client-ts/project"

const rename = Effect.flatMap(ProjectClient, (client) =>
  client.rename({ id, name: "taken" })
).pipe(
  Effect.catchTag("ProjectNameConflict", (error: ProjectNameConflict) =>
    Effect.logWarning(`name "${error.name}" already exists`)
  )
)
```

`Project`, `ProjectCreateResult`, and `ProjectDeleteResult` are re-exported from
the project entrypoint. `SequencedEvent` is exported from the root for consumers
that need stream vocabulary directly.
