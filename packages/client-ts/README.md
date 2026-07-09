# `@expand/client-ts`

The Effect-native client SDK for the Expand backend. It discovers (or spawns) the
backend server, opens an RPC-over-WebSocket session, and gives you either a
**reactive, event-sourced store** of project state or **typed one-call facades** —
all wired with Effect Layers.

> Internal design and runtime behavior live in [ARCHITECTURE.md](./ARCHITECTURE.md).
> This file is the consumer quickstart.

## Install

`@expand/client-ts` is a workspace package inside the Expand monorepo — depend on
it by name, no registry install:

```jsonc
// package.json
{ "dependencies": { "@expand/client-ts": "workspace:*" } }
```

## Entrypoints

| Import                                                    | What it gives you                                                     |
| -------------------------------------------------------- | --------------------------------------------------------------------- |
| `@expand/client-ts` (the **root**)                        | The connection core: `ClientLayer`, `resolveBackendCommand`, `withClient`, transport errors, `RuntimeAdapter`, `ConnectionStatus`, `SequencedEvent`. |
| `@expand/client-ts/project`                               | The project domain: `ProjectStore` / `ProjectStoreLayer`, `ProjectClient`, and the project contract vocabulary (`Project`, domain error tags). |
| `@expand/client-ts/server`                                | The server domain: the `ServerClient` health/presence facade. |
| `@expand/client-ts/adapters/bun` \| `.../adapters/node`  | The platform seam — `makeBunAdapter` / `makeNodeAdapter`. Kept separate because each pulls in platform-only deps. |

Exactly **one canonical import path per symbol** — the root does not re-export
the domain surfaces. Everything else is internal and unreachable (enforced by
the `client-ts-barrel-only` dependency-cruiser rule, which allows only these
entrypoints).

## Happy path

Every layer this SDK builds leaves exactly one dependency unprovided:
`FileSystem` (used to read/write the backend endpoint descriptor). Supply it with
`BunServices.layer` / `NodeServices.layer`. You pick a platform **adapter** and,
usually, a **backend command** (how to spawn the server) resolved via
`resolveBackendCommand`.

### Reactive store (GUI / TUI)

```ts
import { Layer, ManagedRuntime } from "effect"
import { fileURLToPath } from "node:url"
import { BunServices } from "@effect/platform-bun"
import { resolveBackendCommand } from "@expand/client-ts"
import { ProjectStore, ProjectStoreLayer } from "@expand/client-ts/project"
import { makeBunAdapter } from "@expand/client-ts/adapters/bun"

// Resolve the server entry to an ABSOLUTE path relative to this module — a bare
// relative path would resolve against the process cwd and break when the app is
// launched from anywhere but the repo root.
const serverEntry = fileURLToPath(new URL("../server/main.ts", import.meta.url))

const adapter = makeBunAdapter({
  // How to start the backend if one isn't already running.
  backendCommand: () => resolveBackendCommand({ sourceEntry: serverEntry })
})

const runtime = ManagedRuntime.make(
  ProjectStoreLayer(adapter).pipe(Layer.provide(BunServices.layer))
)

const store = await runtime.runPromise(ProjectStore)

// `subscribe` forks a scoped fiber and returns an unsubscribe. It fires
// immediately with the current projects, then on every change.
const unsubscribe = await runtime.runPromise(
  store.subscribe((projects) => render(projects))
)

// Commands don't mutate locally — the server's event stream is the single
// writer; the change flows back through `store.projects` / your subscription.
await runtime.runPromise(store.createProject("my-project"))

// on teardown:
unsubscribe()
await runtime.dispose()
```

Node/Electron consumers use `makeNodeAdapter` + `NodeServices.layer` identically,
except `makeNodeAdapter` **requires** a `backendCommand` (there is no safe
default: Electron's `process.execPath` is the Electron binary, not a JS runtime).
Run the source entry under a real JS runtime by passing `execPath`, which keeps
the resolver's source/compiled existence check:
`resolveBackendCommand({ execPath: "bun", sourceEntry: absoluteEntry })`.

#### Overriding the backend command

`resolveBackendCommand` honours an **`EXPAND_BACKEND_CMD`** environment variable —
a JSON array of strings (e.g. `EXPAND_BACKEND_CMD='["expand-server","--data-dir","/tmp"]'`)
— which wins over both source mode and `binaryArgs`. Handy for pointing a build
at a prebuilt binary without touching code.

Caveat: the override only applies when the command flows through
`resolveBackendCommand`. Passing a **literal array** straight to
`makeBunAdapter`/`makeNodeAdapter` (`backendCommand: ["bun", entry]`) bypasses the
resolver entirely, so `EXPAND_BACKEND_CMD` is ignored. Wrap it in
`resolveBackendCommand` (or `() => resolveBackendCommand({...})`) to keep the env
override live.

### Typed facades (CLI / scripts)

```ts
import { Effect } from "effect"
import { BunServices } from "@effect/platform-bun"
import { ClientLayer } from "@expand/client-ts"
import { ServerClient } from "@expand/client-ts/server"
import { makeBunAdapter } from "@expand/client-ts/adapters/bun"

const program = Effect.flatMap(ServerClient, (server) => server.health()).pipe(
  Effect.provide(ClientLayer(makeBunAdapter())),
  Effect.provide(BunServices.layer)
)

await Effect.runPromise(program)
```

## Which do I use?

| You want…                                                         | Use                                    |
| ----------------------------------------------------------------- | -------------------------------------- |
| A live, reconnecting mirror of project state to render a UI       | **`ProjectStoreLayer`** + `ProjectStore` (`.subscribe` / `.projects`) |
| Request/response RPC calls (`health()`, project commands) as a long-lived service | **`ClientLayer`** + `ProjectClient` / `ServerClient` |
| A single ad-hoc RPC call without standing up a service layer       | **`withClient(adapter, (client) => …)`** |

Rules of thumb:

- **`ProjectStoreLayer` owns its own connection** and re-acquires it on every
  reconnect. Reach for it whenever you display project state.
- **`ClientLayer`** merges the `ProjectClient` + `ServerClient` facades over one
  shared connection acquired at layer build — stateless request/response.
- **`withClient`** is the one-shot escape hatch: acquire the raw client, run your
  effect, tear the scope down. No standing layer.

## Error handling

The SDK's errors are importable from its entrypoints — transport errors from the
root, domain errors from `@expand/client-ts/project` — so you can catch and
pattern-match without deep-importing `@expand/contracts`:

- **`BackendUnavailable`** — the backend couldn't be found, spawned, or reached.
  A `ProjectStoreLayer` **fails with this on first connect**; after that,
  reconnection is automatic and surfaces via `store.status`
  (`"connected" | "reconnecting" | "disconnected"`).
- **`RpcClientError`** — a transport/protocol-level RPC failure (type-only).
- **Domain errors** carried in command result channels: `ProjectNotFound`,
  `ProjectNameConflict`, `ProjectDirectoryInvalid`, `ProjectDirectoryConflict`,
  `ProjectInvalidInput` (and `ProjectAlreadyExists`). These are tagged classes —
  match on `_tag` or use `Effect.catchTag`:

```ts
import { Effect } from "effect"
import { ProjectNameConflict } from "@expand/client-ts/project"

store.renameProject(id, "taken").pipe(
  Effect.catchTag("ProjectNameConflict", (e: ProjectNameConflict) =>
    Effect.logWarning(`name "${e.name}" already exists`))
)
```

Input is validated at the backend's ingestion boundary — the store forwards raw
strings and surfaces `ProjectInvalidInput` rather than branding client-side.

## Contract vocabulary

`Project`, `ProjectCreateResult`, and `ProjectDeleteResult` are re-exported from
`@expand/client-ts/project`; `SequencedEvent` (the shape of `store.events`) from
the root — so you can name the values the API returns without a second import.
