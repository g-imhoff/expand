# `@expand/client-core` — how it works

The client-side library of the Expand monorepo. It discovers/spawns the backend
server, opens an RPC-over-WebSocket session, and maintains a reactive,
event-sourced mirror of project state. Built on **Bun + Effect v4 beta**.

## The mental model

Three concentric layers, each depending only on the one beneath it:

```
ProjectStore / ServerClient / ProjectClient   ← state + typed facades  (what apps use)
        │
   ExpandRpcClient (acquireClient)              ← a live, connected RPC-over-WS session
        │
   RuntimeAdapter (Bun | Node)                 ← platform seam: how to open a socket / spawn a process
```

Everything is wired with **Effect Layers**. Two facts make the rest readable:

- `Context.Service<Self, Shape>()("id")` defines a DI **tag** + the service's
  type. `Layer.effect(Tag, eff)` builds that service by running `eff`;
  `Layer.provide(dep)` feeds one layer's output into another as a dependency;
  `Layer.mergeAll(...)` builds several and unions their outputs.
- A `Layer` is *lazy* — nothing connects until something runs an effect that
  needs the service. Layers are scoped, so teardown (closing sockets, killing
  fibers) is automatic when the scope closes.

---

## 1. Startup: from a Layer to a live socket

An app builds either `ClientLayer(adapter)` (`client-layer.ts:9`) or
`ProjectStoreLayer(adapter)` (`project-store.ts:182`). Both ultimately call
**`acquireClient(adapter)`** (`rpc-client.ts:26`). That function is the whole
connection story, and it has two stages.

### Stage A — find or spawn the backend (`discovery.ts:109`)

```
findOrSpawnBackend:
  readEndpoint              → if a valid live endpoint file exists, REUSE it (return, no spawn)
  else tryAcquireLock       → grab an exclusive .lock file
    if NOT acquired         → someone else is spawning → just awaitEndpoint
    if acquired             → adapter.spawnBackend, then awaitEndpoint
                              (Effect.ensuring(releaseLock) — lock always freed)
```

- **`readEndpoint`** (`discovery.ts:20`) reads `endpointFilePath()` (a JSON file
  like `server.json`), decodes it against the `EndpointFromJson` schema, then
  applies three gates, each returning `Option.none()`: file missing → JSON
  invalid → `protocolVersion !== PROTOCOL_VERSION` → **PID not alive**
  (`process.kill(pid, 0)`, `discovery.ts:11`). Only a file that survives all
  gates counts as a running backend.
- **The lock dance** (`discovery.ts:62-90`) prevents a thundering herd of spawns.
  `createLockOnce` uses `openSync(path, "wx")` — O_EXCL exclusive create, which
  atomically fails if the file exists. If creation fails, `isLockStale()`
  (`discovery.ts:45`) checks for a crashed spawner: lock older than 30s **or**
  its recorded PID is dead → delete and retry once. So exactly one process
  spawns; the rest wait.
- **`awaitEndpoint`** (`discovery.ts:92`) polls `readEndpoint` every 50ms
  (failing `"pending"` until it appears), with a 5s overall timeout →
  `BackendUnavailable("backend did not start in time")`.

### Stage B — connect and handshake (`rpc-client.ts:38-62`)

With an endpoint in hand:

1. `Layer.build(adapter.protocolLayer(endpointWsUrl(endpoint)))` builds the
   WebSocket protocol stack into a context. `endpointWsUrl` (`rpc-client.ts:16`)
   appends the auth token as a query param: `…?token=<encoded>`.
2. `RpcClient.make(ExpandRpcs)` produces the typed `client` — one method per RPC
   in the contract (`client.Health()`, `client.ProjectList()`,
   `client.Connect()`, `client.Events()`, …).
3. **The handshake**: it forks a supervised drain of the streaming RPC
   `client.Connect()`, and the *first emission* fires `Deferred.succeed(ready)`
   (`rpc-client.ts:43-50`). Then `Deferred.await(ready)` waits up to
   `CONNECT_TIMEOUT = 3s`; on timeout it fails with `StaleEndpoint`
   (`rpc-client.ts:51-59`). So "connected" means *the server actually pushed
   presence over the live socket*, not merely "TCP opened."

### Stage B's self-healing retry (`rpc-client.ts:65-73`)

The endpoint file can point at a dead server. So the whole of stage A+B is
wrapped:

```
tapErrorTag("StaleEndpoint", () => deleteEndpoint)   // delete the bad file
retry({ times: 2, while: e is StaleEndpoint })        // ⇒ 3 attempts total; respawns fresh
catchTag("StaleEndpoint", → BackendUnavailable)       // give up after 3
```

On a stale endpoint it deletes the file, so the next attempt's
`findOrSpawnBackend` finds nothing and spawns a brand-new backend. This is
exactly what the `find-or-spawn` regression test guards.

### The adapter seam (`adapter.ts`, `adapters/*.ts`)

`RuntimeAdapter` is just two members (`adapter.ts:5`): `protocolLayer(url)` and
`spawnBackend`. The two implementations differ only in platform primitives:

|                 | Bun (`adapters/bun.ts`)                       | Node (`adapters/node.ts`)                                              |
| --------------- | --------------------------------------------- | ---------------------------------------------------------------------- |
| socket          | `BunSocket.layerWebSocket`                    | `Socket.layerWebSocket` + injected `ws` via `Socket.WebSocketConstructor` |
| serialization   | `RpcSerialization.layerNdjson` (NDJSON)       | same                                                                   |
| spawn           | `Bun.spawn` in `Effect.try` (sync)            | `child_process.spawn` in `Effect.callback`, resolving on `'spawn'`/`'error'` |
| default command | `defaultBackendCommand()` (source vs binary)  | none — `backendCommand` is **required**                                |

Both detach the child (`child.unref()`, stdio ignored) — fire-and-forget;
readiness is confirmed by Stage A's `awaitEndpoint`, not by the spawn itself.

---

## 2. The ProjectStore engine — the real machinery

`makeStore(adapter)` (`project-store.ts:70`) is where the interesting runtime
behavior lives. On build it creates:

- **`state: SubscriptionRef<{projects, seq}>`** — the *single source of truth*.
  projects and seq are always written together (`project-store.ts:78`).
- **`projects: SubscriptionRef<ReadonlyArray<Project>>`** — the public,
  read-only mirror consumers subscribe to.
- `status` (`"disconnected" | "reconnecting" | "connected"`), a `PubSub` event
  `hub`, a `clientRef` holding the current live client, and a `ready: Deferred`
  barrier.
- `hooked = withConnectionHooks(adapter, status)` (`project-store.ts:49`) —
  wraps the adapter so the RPC layer's own `onDisconnect` hook flips
  `status → "reconnecting"` the instant the socket drops.

**The public mirror is a strict projection** (`project-store.ts:88-93`): a forked
fiber runs `Stream.changes` over `state.projects` and writes each new value into
`projects`. The public ref can never diverge from `state`.

### The session loop (`project-store.ts:95-124`)

```
acquireClient(hooked) → client
clientRef := client
queue   = client.Events({}, { asQueue: true })   ← SUBSCRIBE FIRST
snapshot = client.ProjectList({ includeArchived: true })
state := { projects: snapshot.projects, seq: max(s.seq, snapshot.seq) }   ← seed, seq monotonic
projects := snapshot.projects                      ← one-time explicit seed (never show empty [])
status := "connected"
Deferred.succeed(ready)                            ← unblock the store constructor
forever: take(queue) → atomic fold (below)
```

Two ordering decisions make this correct:

- **Subscribe to `Events` *before* `ProjectList`** so no event is missed in the
  gap. Any event arriving in that window is reconciled by the seq gate below.
- **`Math.max` on seq** so a reconnect's fresh snapshot can never move seq
  backward.

### The C2 atomic fold (`project-store.ts:113-119`)

Every incoming event is applied in *one* atomic `SubscriptionRef.modify`:

```
modify(state, s =>
  sequenced.seq <= s.seq
    ? [false, s]                                                   // drop: stale / duplicate / out-of-order
    : [true,  { projects: Project.foldList(s.projects, event),     // gate + fold + seq-bump together
                seq: sequenced.seq }])
.flatMap(applied => applied ? PubSub.publish(hub, sequenced) : void)   // publish only if newly applied
```

This is the **C2 invariant**: because `{projects, seq}` move together
atomically, `store.snapshot` (`= SubscriptionRef.get(state)`, line 149) can
*never* observe a `seq` ahead of the projects it returns. The
`snapshot-consistency` test races 40 concurrent reads against this and asserts
`snapshot.projects` always equals `foldList(events where seq ≤ snapshot.seq)`.
The hub only ever sees *applied* events, so `store.events` is a clean,
deduplicated, ordered stream.

### Readiness + the connection loop (`project-store.ts:126-140`)

```
connectionLoop =
  session
    .tapError(e => Deferred.fail(ready, toUnavailable(e)))   // first connect fails ⇒ the Layer fails
    .exit
    .flatMap(exit =>
        isFailure && hasInterruptsOnly(cause)
          ? failCause(cause)                                  // deliberate shutdown ⇒ stop cleanly
          : status := "reconnecting"; fail(BackendUnavailable("connection lost")))
    .retry(exponential("500ms", 1.5) either spaced("5s"))     // reconnect with capped backoff

forkScoped(supervised("project-store-connection", connectionLoop))
Deferred.await(ready)                                          // store build blocks until first connect
```

`ProjectStoreLayer` only resolves once the **first** session connects; if that
first connect fails, the whole layer fails `BackendUnavailable`. After that, the
loop runs in the background.

---

## 3. A mutation round-trip — and why it's not optimistic

`store.createProject(name)` (`project-store.ts:151`) does **not** touch local
state. It:

1. reads the live client via `current` (`project-store.ts:142` — dies if somehow null),
2. calls `client.ProjectCreate({ name, ensure: true, …directory })`,
3. `.map(r => r.project)`,
4. `.catchTag("ProjectAlreadyExists", Effect.die)` — because `ensure: true` makes
   "already exists" impossible, so it's downgraded to a defect and *removed from
   the public error type*.

The new project appears in `store.projects` only when the server processes the
command, emits a `SequencedEvent`, and that event flows back through `Events` →
the C2 fold → `state` → the mirror. **The server's event stream is the single
writer of local state.** That's why the `cross-store-sync` test works: a
mutation in runtime A shows up in runtime B's store, because both just replay the
same server event stream. (`directory`/`tags`/`description` are spread
conditionally, lines 154/172-173, so explicit `undefined` is never sent over the
wire.)

---

## 4. Reconnection, exactly

When the socket drops: `withConnectionHooks` immediately sets
`status → "reconnecting"`; the `Connect` drain fiber dies, the `session` effect
exits with a non-interrupt failure; `connectionLoop` sets `"reconnecting"` +
fails `"connection lost"`, then `retry` re-runs `session` from scratch with
backoff. A fresh `acquireClient` opens a new socket (respawning the backend if
the old one is gone), `ProjectList` re-seeds, and `Math.max` keeps `seq`
monotonic so no event is double-applied. Event-sourced state survives — the
`reconnect` test kills the backend and asserts both pre-kill and post-kill
projects end up present. An *interrupt-only* exit (deliberate shutdown) instead
propagates via `failCause` and stops the loop cleanly — and `supervised`
(`supervise.ts:3`) makes sure a real crash is logged while a normal interrupt
stays silent.

---

## 5. The facades and the two entry points

- **`ProjectClient` / `ServerClient`** (`project-client.ts`, `server-client.ts`)
  are *stateless* — `Layer.effect` maps a resolved `ExpandRpcClient` into a thin
  typed API, one method delegating to one RPC. `ServerClientApi` is currently
  just `health()`.
- **`ClientLayer(adapter)`** merges those two facades over a *single shared*
  `ExpandRpcClient` connection.
- **`withClient(adapter, use)`** (`with-client.ts:5`) is the one-shot path:
  acquire the raw client, run `use`, tear down the scope — for ad-hoc RPC calls
  without standing up the full layer.

Note the architectural split: `ProjectClient`/`ServerClient`/`withClient` share
the `ExpandRpcClient` *service* (one connection acquired at layer build), but
**`ProjectStore` owns its own connection** — it calls `acquireClient(hooked)`
directly inside its session so it can attach connection hooks, re-acquire on
every reconnect, and manage the lifecycle itself. Both `ClientLayer` and
`ProjectStoreLayer` leave only `FileSystem` unprovided, which the host app
supplies.

---

That's the whole flow: **adapter abstracts the platform → `acquireClient`
finds/spawns/connects/heals → `ProjectStore` seeds, subscribes, and folds the
server's event stream into an atomic reactive replica, surviving reconnects.**
