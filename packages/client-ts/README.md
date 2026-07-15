# `@expand/client-ts`

The Effect-native client SDK for the Expand backend. It discovers or starts the
backend, maintains a reconnecting RPC-over-WebSocket session, and exposes typed
project and server clients. Applications decide how, or whether, to retain
project state.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the connection and synchronization
internals.

## Install

The repository requires Node `>=24.15` and npm `>=11`. This package is an npm
workspace dependency:

```json
{ "dependencies": { "@expand/client-ts": "0.0.0" } }
```

## Entrypoints

| Import | Surface |
| --- | --- |
| `@expand/client-ts` | `ClientSession`, `ClientSessionLayer`, `ClientLayer`, `withClient`, adapter-independent connection types, and transport errors. |
| `@expand/client-ts/project` | The session-backed `ProjectClient` facade and project contract vocabulary. |
| `@expand/client-ts/server` | The session-backed `ServerClient` facade. |
| `@expand/client-ts/adapters/node` | The Node WebSocket and process adapter. |
| `@expand/contracts/project-sync` | The renderer-safe `runProjectSync` controller and its source, sink, snapshot, and status types. |

The root does not re-export domain clients. Use their scoped entrypoints.

## Session-backed clients

`ClientSession` owns connection discovery, initial acquisition, disconnect
observation, and reconnect attempts. Its `status` reports `"connected"`,
`"reconnecting"`, or `"disconnected"`; `current` waits for the active RPC
epoch; and `epochs` emits each newly connected epoch.

`ClientLayer(adapter)` provides one shared session together with `ProjectClient`
and `ServerClient`. The facades delegate each operation through the session, so
commands issued after a reconnect use the current epoch.

Every SDK layer leaves `FileSystem`, `Path`, `Crypto`, `AppContext`, and
`ProcessControl` unprovided. Applications own the context that selects their
data root; Node hosts satisfy the platform and process services with
`ProcessServices.layer` and provide an application-defined
`nodeAppContextLayer` that lazily acquires home, cwd, and `Stdio.args`. The SDK
does not read argv or install a context internally.

```ts
import { Effect, Layer } from "effect"
import { ClientLayer } from "@expand/client-ts"
import { ProjectClient } from "@expand/client-ts/project"
import { makeNodeAdapter, ProcessServices } from "@expand/client-ts/adapters/node"
import { nodeAppContextLayer } from "./node-app-context"

const adapter = makeNodeAdapter({
  backendCommand: Effect.succeed([
    process.execPath,
    "--import",
    "tsx",
    "/absolute/path/to/apps/server/main.ts"
  ])
})

const clientLayer = ClientLayer(adapter).pipe(
  Layer.provide(nodeAppContextLayer),
  Layer.provide(ProcessServices.layer)
)

const program = Effect.flatMap(ProjectClient, (client) =>
  client.list({ includeArchived: true })
).pipe(Effect.provide(clientLayer))

const snapshot = await Effect.runPromise(program)
```

Use `ProjectClientLayer(adapter)` or `ServerClientLayer(adapter)` when only one
facade is needed. Use `withClient(adapter, use)` for a scoped low-level call.

## Backend commands

`makeNodeAdapter` accepts an Effect that returns a command array and can fail
with `BackendCommandError` while requiring `FileSystem`. In application code,
`resolveBackendCommand` creates that Effect by applying this priority:

1. `EXPAND_BACKEND_CMD`, when it is a JSON array of strings.
2. An absolute TypeScript `sourceEntry`, normally with
   `runtimeArgs: ["--import", "tsx"]`.
3. `binaryArgs` for packaged execution.

The adapter appends the selected `--data-dir` argument itself. Electron hosts
must pass an explicit `execPath: "node"` because Electron's `process.execPath`
names the Electron executable.

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
  status: (status) => Effect.sync(() => setStatus(status)),
  snapshot: (snapshot) => Effect.sync(() => setSnapshot(snapshot))
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
again and replaces the old projects and sequence with the fresh authoritative
snapshot before replaying newer events.

The controller also recovers when `list` or `Events` fails, or when `Events`
ends cleanly while the source still reports a connected session. It publishes
`"reconnecting"`, retries a complete list-and-events epoch with capped backoff,
and publishes `"connected"` after a fresh snapshot succeeds. A failure of the
source status stream is owner-visible instead: it fails `runProjectSync` so the
application supervising the synchronization fiber can surface it.
Sink callbacks are Effects and remain part of the serial delivery path. A sink
failure propagates to that same owner without entering the source retry loop.

The applications deliberately choose different ownership models:

- Desktop stores synchronized snapshots and status in a renderer-owned Zustand
  store. Boot races the first snapshot against sync failure and then joins the
  sync fiber so later failures reach its owner.
- TUI stores synchronized snapshots in React state and interrupts the sync fiber
  when the component unmounts.
- CLI remains stateless: each command calls the typed facade and renders the
  response without maintaining a replica.

Mutation responses are not an optimistic state source for desktop or TUI. Their
visible state changes only through a fresh list or sequenced server event.

## Errors

Import transport errors from the root and domain errors from
`@expand/client-ts/project`:

- `BackendUnavailable` means initial backend discovery, startup, or connection
  failed. After initial acquisition, reconnecting is reflected by session
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
