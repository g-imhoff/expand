# Effect v4 Beta Migration Reference

**Target version:** `effect@4.0.0-beta.74`. Every API below was verified against installed `.d.ts` sources under `/home/g-imhoff/projects/yodea/node_modules`. Where a report flagged something unconfirmed, it is preserved in §4.

---

## 1. Version set

Exact pins (Effect stack is the single `effect` package now; platform/SQL adapters remain separate packages). Versions are taken verbatim from the reports' verified installs.

```jsonc
{
  "dependencies": {
    "effect": "4.0.0-beta.74",
    "@effect/platform-bun": "<matching beta>",     // BunRuntime, BunServices, BunHttpServer, BunSocket
    "@effect/sql-sqlite-bun": "<matching beta>"     // SqliteClient, SqliteMigrator
  },
  "devDependencies": {
    "typescript": "6.0.3",
    "vitest": "4.1.7",
    "dependency-cruiser": "17.4.2",
    "@types/bun": "1.3.14",
    "@types/node": "25.9.1"
  }
}
```

**Notes / uncertainties on versions:**
- The reports verified `effect@4.0.0-beta.74`, `typescript@6.0.3`, `vitest@4.1.7`, `dependency-cruiser@17.4.2`, `@types/bun@1.3.14`, `@types/node@25.9.1`, and `vite@8.0.14` (transitive, satisfies vitest 4's `^6 || ^7 || ^8` peer).
- **`@effect/platform-bun` and `@effect/sql-sqlite-bun` exact version strings were NOT quoted** in any report (only that they are "v4" / `4.0.0-beta.x` compatible and import from `effect/unstable/*`). The implementer must read these two from the installed `node_modules/@effect/platform-bun/package.json` and `node_modules/@effect/sql-sqlite-bun/package.json` and pin them.
- `effect` v4's `package.json` declares **no `engines` and no `typescript` peerDependency** — TS 6.0.3 working is empirical, not contractual. A future beta could tighten lib requirements.
- Runtime engine floors (from `--info`): dependency-cruiser 17.4.2 → Node `^20.12 || ^22 || >=24`; vitest 4 → Node `^20 || ^22 || >=24`.

---

## 2. Import map

Everything that was a separate package in 3.x is now either core top-level `effect` or `effect/unstable/<area>`. Bun and SQLite-Bun adapters remain separate packages but re-export from `effect/unstable/*`.

### From `effect` core (3.x `effect` / `@effect/schema`)

| 3.x import | v4 import path |
|---|---|
| `import { Effect } from "effect"` | `import { Effect } from "effect"` (unchanged) |
| `Layer`, `Context`, `Scope`, `Ref`, `Deferred`, `Fiber`, `Data`, `Option`, `Schedule`, `Console`, `Stream`, `PubSub`, `Queue` | all from `"effect"` (unchanged root) |
| `Context.Tag(...)` / `Effect.Service(...)` | `Context.Service(...)` (from `"effect"`) — see §3 |
| `import { Schema } from "@effect/schema"` / `effect/Schema` | `import { Schema } from "effect"` (core top-level) |
| `@effect/schema` parser internals | `SchemaParser`, `SchemaAST`, `SchemaIssue`, `SchemaGetter`, `SchemaTransformation` (named exports from `"effect"`) |

### From `@effect/platform` → core top-level `effect`

| 3.x import | v4 import path |
|---|---|
| `@effect/platform/FileSystem` | `effect/FileSystem` (or `import { FileSystem } from "effect"`) |
| `@effect/platform/Path` | `effect/Path` (or `import { Path } from "effect"`) |
| `@effect/platform/Error` (PlatformError) | `effect/PlatformError` (also re-exported from `"effect"`) |
| `@effect/platform/Terminal` | `effect/Terminal` |
| (new) Stdio service | `effect/Stdio` |

### From `@effect/platform` → `effect/unstable/*`

| 3.x import | v4 import path |
|---|---|
| `@effect/platform/HttpRouter` | `effect/unstable/http` (namespace `HttpRouter`) |
| `@effect/platform/HttpServer` | `effect/unstable/http` (namespace `HttpServer`) |
| `@effect/platform/HttpServerResponse` / `HttpServerRequest` | `effect/unstable/http` |
| `@effect/platform/Socket` | `effect/unstable/socket` (namespace `Socket`) |

### From `@effect/rpc` → `effect/unstable/rpc`

| 3.x import | v4 import path |
|---|---|
| `@effect/rpc/Rpc` | `effect/unstable/rpc` (namespace `Rpc`) |
| `@effect/rpc/RpcGroup` | `effect/unstable/rpc` (`RpcGroup`) |
| `@effect/rpc/RpcClient` | `effect/unstable/rpc` (`RpcClient`) |
| `@effect/rpc/RpcServer` | `effect/unstable/rpc` (`RpcServer`) |
| `@effect/rpc/RpcSerialization` | `effect/unstable/rpc` (`RpcSerialization`) |
| `@effect/rpc/RpcMessage` / `RpcSchema` / `RpcMiddleware` / `RpcTest` | `effect/unstable/rpc` |

> `@effect/rpc` as a package **no longer exists**.

### From `@effect/cli` → `effect/unstable/cli`

| 3.x import | v4 import path |
|---|---|
| `import { Command } from "@effect/cli"` | `import { Command } from "effect/unstable/cli"` |
| `import { Options } from "@effect/cli"` | `import { Flag } from "effect/unstable/cli"` (**renamed**) |
| `import { Args } from "@effect/cli"` | `import { Argument } from "effect/unstable/cli"` (**renamed**) |
| (`@effect/cli` misc) | `GlobalFlag`, `Param`, `Primitive`, `CliError`, `CliOutput`, `Completions`, `HelpDoc`, `Prompt` all from `effect/unstable/cli` |

### From `@effect/sql` → `effect/unstable/sql/*`

| 3.x import | v4 import path |
|---|---|
| `@effect/sql/SqlClient` | `effect/unstable/sql/SqlClient` |
| `@effect/sql/Statement` | `effect/unstable/sql/Statement` |
| `@effect/sql/SqlError` | `effect/unstable/sql/SqlError` |
| `@effect/sql/Migrator` | `effect/unstable/sql/Migrator` |
| (new) Reactivity service | `effect/unstable/reactivity/Reactivity` |

### `@effect/sql-sqlite-bun` (package preserved)

| 3.x import | v4 import path |
|---|---|
| `@effect/sql-sqlite-bun` SqliteClient | `import { SqliteClient } from "@effect/sql-sqlite-bun"` (client types resolve to `effect/unstable/sql/*`) |
| `@effect/sql-sqlite-bun` Migrator | `import { SqliteMigrator } from "@effect/sql-sqlite-bun"` |

### `@effect/platform-bun` (package preserved)

| 3.x import | v4 import path |
|---|---|
| `BunRuntime.runMain` | `import { BunRuntime } from "@effect/platform-bun"` (or `@effect/platform-bun/BunRuntime`) — same name |
| `BunContext.layer` | `import { BunServices } from "@effect/platform-bun"` → `BunServices.layer` (**renamed + narrower**) |
| `BunHttpServer.layer` | `import { BunHttpServer } from "@effect/platform-bun"` |
| (new) Bun WS Socket | `import { BunSocket } from "@effect/platform-bun"` |
| (narrower individual) | `BunFileSystem`, `BunPath`, `BunTerminal`, `BunStdio` from `@effect/platform-bun` |

---

## 3. API patterns

### 3.1 Service + Layer definition

**`Effect.Service` and `Context.Tag` are GONE.** The constructor is `Context.Service`. There is **no auto-generated `.Default` layer** — you wire the layer manually with `Layer.effect`.

```ts
import { Context, Effect, Layer, Console } from "effect"

// Service with an effectful + SCOPED constructor stored in `make`:
class Db extends Context.Service<Db, {
  readonly query: (sql: string) => Effect.Effect<string>
}>()("app/Db", {
  make: Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Console.log("closing db")) // scoped acquisition
    return { query: (sql: string) => Effect.succeed(`R:${sql}`) }
  })
}) {}

// Build the Layer from the stored constructor (NO auto .Default in v4):
const DbLayer = Layer.effect(Db, Db.make)   // Layer<Db, never, never> (Scope consumed by Layer.effect)

// Access the service — yield the class itself (it IS an Effect<Shape, never, Db>):
const useDb = Effect.gen(function* () {
  const db = yield* Db
  return yield* db.query("SELECT 1")
})

// Function-style (no class) key + .use accessor:
const Logger = Context.Service<{ log: (m: string) => void }>("Logger")
const useLogger = Logger.use((l) => Effect.sync(() => l.log("hi")))
```

Key signatures (from `Context.d.ts`):
- `interface Service<Identifier, Shape> extends Key<Identifier, Shape>` with `of(self)`, `context(self)`, `use(f)`, `useSync(f)`. `Key extends Effect<Shape, never, Identifier>` (so the class/key is directly `yield*`-able).
- First type param is **`Self`** (the class type); the runtime arg is the string id.
- Passing `options.make` gives the class a static `.make` property. Build the layer with `Layer.effect(X, X.make)`.
- `Context.Reference(key, { defaultValue })` — service key with a default value (replaces FiberRef-style defaults).

How unmet requirements surface (verified): `Effect.Effect<string, never, Db>` before provide; `Effect.Effect<string, never, never>` after `Effect.provide(DbLayer)`. In `Layer<ROut, E, RIn>`, unmet deps appear in `RIn`.

**Layer API** (`Layer.d.ts`), type `Layer<in ROut, out E = never, out RIn = never>`:
- `Layer.effect(service, effect)` — `Scope.Scope` in the effect's `R` is consumed (`Exclude<R, Scope.Scope>`). **This is the v4 way to build scoped layers** — there is no standalone `Layer.scoped` const.
- `Layer.succeed(service, value)`, `Layer.mergeAll(...layers)`, `Layer.merge(a, b)`, `Layer.empty`.
- `Layer.provide(that)` / `Layer.provideMerge(that)` — **both now also accept a tuple/array of layers** directly (no need to `mergeAll` first). `provideMerge` keeps the provided layer's outputs in `ROut`.
- `Layer.launch(self): Effect<never, E, RIn>` — runs a layer as a never-ending Effect.
- `Layer.effectDiscard`, `Layer.unwrap`, `Layer.fresh`, `Layer.catchTag`, `Layer.catchCause`.
- Extractors: `Layer.Success<T>` (ROut), `Layer.Error<T>` (E), `Layer.Services<T>` (RIn).

```ts
const both: Layer.Layer<A | B> = Layer.mergeAll(la, lb)
const wired = serviceLayer.pipe(Layer.provide(Layer.mergeAll(databaseLayer, loggerLayer)))
const launched: Effect.Effect<never, never, never> = Layer.launch(appLayer)
```

### 3.2 PubSub create / publish / subscribe + Stream drain + emit-one-then-stay-open

**Biggest change:** `PubSub.subscribe` now yields a `PubSub.Subscription<A>` (NOT a `Queue.Dequeue<A>`). Consume it with `PubSub.take`/`takeAll`/`takeUpTo` (NOT `Queue.take`). `Stream.fromPubSub` takes a bare `PubSub` (no Scope, no `{ scoped }`). `Stream.unwrapScoped` is **removed** (use `Stream.unwrap`).

```ts
import { Effect, PubSub, Stream } from "effect"

const program = Effect.gen(function* () {
  const pubsub = yield* PubSub.unbounded<string>()      // optional { replay } arg
  yield* Effect.scoped(Effect.gen(function* () {
    const sub = yield* PubSub.subscribe(pubsub)          // Subscription<string>, scoped
    yield* PubSub.publish(pubsub, "hello")               // Effect<boolean>
    const msg = yield* PubSub.take(sub)                  // "hello"
  }))
})
```

Signatures:
- `PubSub.unbounded<A>(options?: { replay?: number }): Effect.Effect<PubSub<A>>` (no Scope).
- `PubSub.publish(self, value): Effect.Effect<boolean>` (dual). Also `PubSub.publishUnsafe`, `PubSub.publishAll`.
- `PubSub.subscribe(self): Effect.Effect<Subscription<A>, never, Scope.Scope>`.
- `PubSub.take(self: Subscription<A>): Effect.Effect<A>`.

**Long-lived drainer (idiomatic).** `Stream.fromPubSub(pubsub): Stream<A>` self-subscribes; run on a child fiber:

```ts
import { Effect, PubSub, Stream } from "effect"

const drain = (pubsub: PubSub.PubSub<MyEvent>) =>
  Stream.fromPubSub(pubsub).pipe(   // Stream<MyEvent>, R = never; self-subscribes
    Stream.tap((ev) => handle(ev)),
    Stream.runDrain                 // Effect<void, never, never>; runs until interrupted
  )

const main = Effect.gen(function* () {
  const pubsub = yield* PubSub.unbounded<MyEvent>()
  const fiber = yield* Effect.forkChild(drain(pubsub))   // NOTE: Effect.fork is GONE
  // publishers: yield* PubSub.publish(pubsub, ev)
})
```

If you must hold the subscription explicitly, use `PubSub.subscribe` + `Stream.fromSubscription(sub)` (new in v4):

```ts
const drainExplicit = (pubsub: PubSub.PubSub<MyEvent>) =>
  Effect.scoped(Effect.gen(function* () {
    const sub = yield* PubSub.subscribe(pubsub)            // Subscription, scoped
    yield* Stream.fromSubscription(sub).pipe(Stream.runForEach((ev) => handle(ev)))
  }))
```

**Emit one value then stay open** (`concat` + `never`, both unchanged):

```ts
import { Stream } from "effect"

const liveStream = <A>(initial: A): Stream.Stream<A> =>
  Stream.make(initial).pipe(Stream.concat(Stream.never))

// Realistic: snapshot then keep channel open for later pushes:
const snapshotThenLive = <A>(snapshot: A, updates: PubSub.PubSub<A>) =>
  Stream.make(snapshot).pipe(Stream.concat(Stream.fromPubSub(updates)))
```

Other Stream facts: `Stream<A, E = never, R = never>`; `Stream.make(...values)` = `Stream.fromArray(values)`; `Stream.never` is a value; `Stream.tap` now takes optional `{ concurrency }`; `Stream.take(n)`, `Stream.runDrain`, `Stream.runHead` (→ `Option`), `Stream.runForEach` unchanged. `Stream.unwrap(effect)` strips `Scope.Scope` from `R` (replaces `unwrapScoped`); `Stream.scoped(stream)` takes a **Stream** (not an Effect) and discharges that stream's own Scope.

Queue (only if used directly): `Queue.take(self: Dequeue<A, E>): Effect<A, E>` — Queues now carry a typed `E`/done channel (`Cause.Done` on end), replacing the 3.x shutdown-interruption model. `Queue.take` does NOT accept a `PubSub.Subscription`.

### 3.3 Schema — tagged struct/union, JSON encode-decode, type extraction

Import: `import { Schema } from "effect"` (core top-level). `effect/unstable/schema` is **DB Models only** (`Model`, `VariantSchema`) — do NOT use it for event/DTO contracts.

**Tagged struct** (auto `_tag` + `.make`):

```ts
import { Schema } from "effect"

const TaskCreated = Schema.TaggedStruct("TaskCreated", {
  taskId: Schema.String,
  title:  Schema.String
})
const ev = TaskCreated.make({ taskId: "t1", title: "Buy milk" }) // _tag auto-filled
type TaskCreated = typeof TaskCreated.Type
// { readonly _tag: "TaskCreated"; readonly taskId: string; readonly title: string }
```

Plain struct, optional fields use `Schema.optionalKey(S)` (key absent) or `Schema.optional(S)` (value `| undefined`):
```ts
const Person = Schema.Struct({
  name: Schema.String,
  age: Schema.Number,
  email: Schema.optionalKey(Schema.String)
})
```

**Tagged union** — `Schema.Union` takes an **ARRAY** now (`Schema.Union([A, B])`, optional `{ mode: "anyOf" | "oneOf" }`):

```ts
const TaskCreated   = Schema.TaggedStruct("TaskCreated",   { taskId: Schema.String })
const TaskCompleted = Schema.TaggedStruct("TaskCompleted", { taskId: Schema.String })
const TaskEvent = Schema.Union([TaskCreated, TaskCompleted])
type TaskEvent = typeof TaskEvent.Type
```

New helpers: `Schema.TaggedUnion({ Circle: {...}, Rectangle: {...} })` (gives `.match`, `.guards`, `.cases`); `Schema.toTaggedUnion("_tag")`; `Schema.Literals([...])` for multi-literal unions.

**Tagged class** (constructed with `new`):
```ts
class Circle extends Schema.TaggedClass<Circle>()("Circle", { radius: Schema.Number }) {}
const c = new Circle({ radius: 5 })  // c._tag === "Circle"
// Error classes: Schema.ErrorClass / Schema.TaggedErrorClass (replace 3.x Schema.TaggedError)
```

**JSON encode/decode** — `Schema.parseJson` is **renamed `Schema.fromJsonString`**. JSON string is the *Encoded* side:

```ts
import { Schema } from "effect"

const TaskCreatedJson = Schema.fromJsonString(TaskCreated)  // string <-> TaskCreated.Type

const json = Schema.encodeUnknownSync(TaskCreatedJson)(
  TaskCreated.make({ taskId: "t1", title: "Buy milk" })
)  // '{"_tag":"TaskCreated","taskId":"t1","title":"Buy milk"}'

const back = Schema.decodeUnknownSync(TaskCreatedJson)(json)
```

**Codec runners** — `Schema.decode` / `Schema.encode` are NO LONGER runners (they are transformation combinators now). Use the explicit runners:

| Need | Function | Returns |
|---|---|---|
| sync from unknown | `Schema.decodeUnknownSync(s)(input)` | `S["Type"]`, **throws `SchemaError`** |
| sync typed input | `Schema.decodeSync(s)(input)` | `S["Type"]`, throws |
| Effect | `Schema.decodeUnknownEffect(s)(input)` | `Effect<S["Type"], SchemaError, S["DecodingServices"]>` |
| Exit | `Schema.decode{Unknown}Exit` | `Exit<S["Type"], SchemaError>` |
| Option | `Schema.decode{Unknown}Option` | `Option<S["Type"]>` |
| Result | `Schema.decode{Unknown}Result` | `Result<S["Type"], Issue.Issue>` (replaces 3.x Either) |
| Promise | `Schema.decode{Unknown}Promise` | `Promise<S["Type"]>` |
| encode | `Schema.encodeSync` / `encodeUnknownSync` / `encodeUnknownEffect` / … | mirror the decode variants → `S["Encoded"]` |

```ts
const User = Schema.Struct({ name: Schema.String, age: Schema.Number })
const u1 = Schema.decodeUnknownSync(User)({ name: "Ada", age: 36 })          // throws on fail
const u2 = Schema.decodeUnknownEffect(User)({ name: "Ada", age: 36 })        // Effect<..., SchemaError>
const enc = Schema.encodeSync(User)(u1)
```

**Type extraction** — both work; encoded-helper moved namespace:
```ts
type P1 = typeof Person.Type                    // idiomatic shorthand
type P2 = Schema.Schema.Type<typeof Person>     // namespace helper (unchanged)
type E1 = typeof Person.Encoded
type E2 = Schema.Codec.Encoded<typeof Person>   // was Schema.Schema.Encoded in 3.x — moved to Codec
```

Primitives are values: `Schema.String`, `Schema.Number` (allows NaN/Infinity; use `Schema.Finite` to exclude), `Schema.Boolean`. `Schema.Array(elem)` → `ReadonlyArray<T>`; `Schema.NonEmptyArray(elem)`.

### 3.4 RPC — group + handlers + WS server (BunHttpServer) + WS client

```ts
import { Rpc, RpcGroup, RpcClient, RpcServer, RpcSerialization } from "effect/unstable/rpc"
import { Socket } from "effect/unstable/socket"
import { HttpRouter } from "effect/unstable/http"
import { Schema, Layer, Effect } from "effect"
import { BunHttpServer, BunSocket } from "@effect/platform-bun"
import { runMain } from "@effect/platform-bun/BunRuntime"
```

**Group + RPCs.** `Rpc.make("Tag", { payload, success, error, stream })`. `payload` accepts a Schema OR plain struct fields (auto-wrapped). `stream: true` wraps success/error into `RpcSchema.Stream<...>` and sets the normal error to `Schema.Never`.

```ts
class UserNotFound extends Schema.ErrorClass<UserNotFound>("UserNotFound")({
  _tag: Schema.tag("UserNotFound"),
  id: Schema.String
}) {}

const GetUser = Rpc.make("GetUser", {
  payload: { id: Schema.String },                                   // struct fields -> auto Struct
  success: Schema.Struct({ id: Schema.String, name: Schema.String }),
  error: UserNotFound
})
const WatchUsers = Rpc.make("WatchUsers", {
  payload: { since: Schema.Number },
  success: Schema.Struct({ id: Schema.String, name: Schema.String }),
  error: Schema.Never,
  stream: true
})

export class UserRpcs extends RpcGroup.make(GetUser, WatchUsers) {}   // class-extends still valid
```

**Handlers** via `group.toLayer` (instance method). Handler fn signature gained a second `options` arg `{ client, requestId, headers, rpc }`:

```ts
export const UserHandlers = UserRpcs.toLayer(
  Effect.gen(function* () {
    const db = yield* UserRepo
    return {
      GetUser: ({ id }) => db.find(id),          // Effect<User, UserNotFound>
      WatchUsers: ({ since }) => db.stream(since) // Stream<User, never>
    }
  })
)
// eager form also valid: UserRpcs.toLayer({ GetUser: ..., WatchUsers: ... })
```

**WS server on BunHttpServer.** WS protocol layer is `RpcServer.layerProtocolWebsocket({ path })` (note lowercase `s` in `Websocket`). Runner is `RpcServer.layer(group)`. Serialization: `RpcSerialization.layerNdjson` (good for WS framing). `HttpRouter.serve(appLayer)` then `BunHttpServer.layer({ port })`:

```ts
const RpcLayer = RpcServer.layer(UserRpcs).pipe(
  Layer.provide(UserHandlers),
  Layer.provide(RpcServer.layerProtocolWebsocket({ path: "/rpc" })),
  Layer.provide(RpcSerialization.layerNdjson)
)
const HttpLive = HttpRouter.serve(RpcLayer).pipe(
  Layer.provide(BunHttpServer.layer({ port: 3000 }))
)
runMain(Layer.launch(HttpLive))
```

Convenience all-in-one: `RpcServer.layerHttp({ group, path, protocol? })` — **defaults to WebSocket**.

**WS client.** There is **no `layerProtocolWebsocket` on the client** — WS = `RpcClient.layerProtocolSocket()` + a WebSocket-backed `Socket`:

```ts
const ProtocolLive = RpcClient.layerProtocolSocket().pipe(
  Layer.provide(RpcSerialization.layerNdjson),
  Layer.provide(Socket.layerWebSocket("ws://localhost:3000/rpc")),
  Layer.provide(Socket.layerWebSocketConstructorGlobal)
  // On Bun, instead: Layer.provide(BunSocket.layerWebSocket("ws://localhost:3000/rpc"))
  //   — BunSocket.layerWebSocket is Layer<Socket, never, never> (bundles the constructor)
)

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(UserRpcs)      // requires Protocol + Scope
  const user = yield* client.GetUser({ id: "42" })    // Effect<User, UserNotFound | RpcClientError>
  yield* client.WatchUsers({ since: 0 }).pipe(/* Stream consumption */ (s) => s)
}).pipe(Effect.scoped, Effect.provide(ProtocolLive))
```

Client errors are surfaced as `RpcClientError` unioned into each method's error channel. Stream calls accept `{ asQueue, streamBufferSize, headers, context }`; non-stream accept `{ headers, context, discard }` (`discard: true` → `Effect<void>`, drops error channel).

### 3.5 CLI — command + subcommands + flags + run via BunRuntime

`Options` → `Flag`, `Args` → `Argument`. `Command.run` no longer takes `name`. Env layer is `BunServices.layer`.

```ts
import { Console, Effect } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { BunRuntime, BunServices } from "@effect/platform-bun"

const list = Command.make(
  "list",
  { json: Flag.boolean("json").pipe(Flag.withDescription("Output as JSON"), Flag.withDefault(false)) },
  ({ json }) => Console.log(json ? "[]" : "no items")
)
const greet = Command.make(
  "greet",
  { name: Argument.string("name") },
  ({ name }) => Console.log(`Hello, ${name}!`)
)

const root = Command.make("yodea").pipe(Command.withSubcommands([list, greet]))

const cli = Command.run(root, { version: "1.0.0" })   // Effect<void, CliError | E, Environment>

cli.pipe(Effect.provide(BunServices.layer), BunRuntime.runMain)
```

Key facts:
- `Command.make(name)` | `(name, config)` | `(name, config, handler)`. Handler must return `Effect<void, E, R>`. `R` auto-excludes `GlobalFlag.BuiltInSettingContext`.
- Flags: `Flag.boolean/string/integer/float/date/choice/file/directory`. Combinators: `Flag.withDefault` (literal or `Effect<B, CliError, Param.Environment>`), `Flag.withAlias("v")`, `Flag.withDescription`, `Flag.optional` (→ `Flag<Option<A>>`). Boolean UX: `--json`/`--no-json`.
- Arguments: `Argument.string("name")` (positional, was `Args.text({name})`). `Args.repeated` → `Argument.string(...).pipe(Argument.variadic({ min, max }))` (or `atLeast`/`atMost`/`between`).
- Subcommands: `Command.withSubcommands([sub1, sub2])`. Shared parent flags: `Command.withSharedFlags({...})` / `Command.withGlobalFlags`; subcommand reads parent via `yield* parentCommand`.
- Running: `Command.run(cmd, { version })` returns an `Effect` (reads argv from `Stdio`). Explicit-args form for tests: `Command.runWith(cmd, { version })(argv)`.
- `BunRuntime.runMain` requires `R = never` → provide `BunServices.layer` first. `Environment` = `FileSystem | Path | Terminal | ChildProcessSpawner | Stdio` — all covered by `BunServices.layer`. Built-in global flags (`--help`, `--version`, `--completions`, `--log-level`) injected automatically.

### 3.6 SqliteClient layer + sql query/insert + WAL

```ts
import { Effect, Layer } from "effect"
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { Migrator } from "effect/unstable/sql/Migrator"

// WAL is ON by default; pass disableWAL: true to turn it off.
const SqlLive = SqliteClient.layer({ filename: "./app.db" })
//   Layer<SqliteClient | SqlClient> — self-provides Reactivity; NO requirements left.

interface User { readonly id: number; readonly name: string }

const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  const users = yield* sql<User>`SELECT id, name FROM users WHERE id = ${42}`  // ReadonlyArray<User>
  yield* sql`INSERT INTO users ${sql.insert({ name: "Ada" })}`
  yield* sql`INSERT INTO users ${sql.insert([{ name: "a" }, { name: "b" }])}` // bulk
  yield* sql.withTransaction(sql`UPDATE users SET name = ${"X"} WHERE id = ${1}`)
}).pipe(Effect.provide(SqlLive))

// Migrator (provide SqlLive):
const MigratorLive = SqliteMigrator.layer({
  loader: Migrator.fromFileSystem("./migrations"),  // requires FileSystem service in Loader
  table: "effect_sql_migrations",
}).pipe(Layer.provide(SqlLive))
```

Facts:
- `SqliteClient.layer(config): Layer<SqliteClient | SqlClient>` — **internally provides `Reactivity`**, so the result layer has empty requirements and provides BOTH `SqliteClient` and the generic `SqlClient.SqlClient`. (Only `SqliteClient.make`/`SqlClient.make` directly require `Scope | Reactivity`.)
- `SqliteClientConfig`: `{ filename, readonly?, create?, readwrite?, disableWAL?, spanAttributes?, transformResultNames?, transformQueryNames? }`. **WAL on by default** (`PRAGMA journal_mode = WAL` unless `disableWAL: true`). No pool options.
- A `Statement<A>` IS an `Effect<ReadonlyArray<A>, SqlError>`; also `.stream`, `.raw`, `.values`, `.compile`.
- `sql.insert`, `sql.in`, `sql.update`, `sql.and`, `sql.or`, `sql.csv`, `sql.join`, `sql.unsafe`, `sql.literal`, `sql.onDialect` preserved. **`sql.updateValues` and `.stream` are unsupported on Bun SQLite** (`updateValues: never`).
- `SqlError` is now a structured `Schema.Class` (`Schema.TaggedStruct<"SqlError", { reason }>`) with a `SqlErrorReason` union (`ConnectionError`, `UniqueViolation`, `SqlSyntaxError`, …), each with `isRetryable`. Guard: `SqlError.isSqlError`.
- `SqliteClient` adds `export: Effect<Uint8Array, SqlError>` and `loadExtension(path)`.

### 3.7 FileSystem / Path usage

Both moved to core top-level `effect`; tags are `Context.Service` (still `yield*`-ed by the class).

```ts
import { Effect, FileSystem, Path } from "effect"

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  yield* fs.makeDirectory("./data", { recursive: true })
  const file = path.join("data", "config.json")
  if (!(yield* fs.exists(file))) {
    yield* fs.writeFileString(file, "{}")
  }
  const content = yield* fs.readFileString(file)
  yield* fs.remove("./data", { recursive: true, force: true })
})
// Provide via BunServices.layer (bundle) or BunFileSystem.layer + BunPath.layer / Path.layer (POSIX)
```

Methods (return `Effect<…, PlatformError>`): `writeFileString(path, data, {flag?, mode?})`, `readFileString(path, encoding?)`, `exists(path)`, `remove(path, {recursive?, force?})`, `makeDirectory(path, {recursive?, mode?})`. `PlatformError` is `effect/PlatformError`. `Path.Path` methods (sync, mostly non-Effect): `join`, `resolve`, `dirname`, `basename`, `extname`, `normalize`, `relative`, `isAbsolute`, `parse`, `format`, `sep`; `fromFileUrl`/`toFileUrl` return `Effect<…, BadArgument>`. Method signatures match 3.x.

### 3.8 acquireRelease / scoped / finalizer

```ts
import { Effect, Console, Scope } from "effect"

// acquireRelease: release callback now takes (value, exit)
const resource = Effect.acquireRelease(
  Effect.sync(() => openHandle()),
  (handle, exit) => Effect.sync(() => handle.close())   // Exit available as 2nd arg
)

// addFinalizer: receives the Exit
const withFin = Effect.addFinalizer((exit) => Console.log(`done: ${exit._tag}`))
//   Effect<void, never, Scope.Scope>

// discharge the Scope requirement:
const scopedAway: Effect.Effect<void, never, never> = Effect.scoped(withFin)
```

- `Effect.acquireRelease(acquire, release, { interruptible? })` → `Effect<A, E, R | R2 | Scope>`. `release: (a, exit) => Effect<unknown, never, R2>`.
- `Effect.addFinalizer(finalizer: (exit) => Effect<void, never, R>) => Effect<void, never, R | Scope>`.
- `Effect.scoped(self) => Effect<A, E, Exclude<R, Scope>>`.
- **Scope tag is `Scope.Scope`** (`Context.Service<Scope, Scope>`). Require as `Effect.Effect<A, E, Scope.Scope>`.
- `Scope.make(strategy?: "sequential" | "parallel")`, `Scope.close(self, exit)`. **`Scope.extend` is GONE** → `Scope.provide(scope)` (curried) or `Scope.use(closeable)`. `Scope.fork`, `Scope.addFinalizer`. `unsafeMake`/`unsafeClose` → `makeUnsafe`/`closeUnsafe`.

### 3.9 Ref / Deferred

```ts
import { Effect, Ref, Deferred } from "effect"

const refDemo = Effect.gen(function* () {
  const ref = yield* Ref.make(0)         // Effect<Ref<number>>; Ref.makeUnsafe for sync
  yield* Ref.update(ref, (n) => n + 1)
  const v = yield* Ref.get(ref)
  yield* Ref.set(ref, 10)
})

const defDemo = Effect.gen(function* () {
  const d = yield* Deferred.make<string>()   // Deferred<string, never>
  yield* Deferred.succeed(d, "ready")        // Effect<boolean>
  const done = yield* Deferred.isDone(d)      // Effect<boolean>
  const val = yield* Deferred.await(d)        // Effect<string>; accessed as Deferred.await
})
```

- `Ref.make`, `Ref.get`, `Ref.set`, `Ref.modify`, `Ref.update`, `Ref.updateAndGet` — all return Effects; shapes unchanged. `Ref.makeUnsafe` (was `unsafeMake`).
- `Deferred.make<A, E = never>()`, `Deferred.succeed/fail/complete/done/completeWith` (return `Effect<boolean>`), `Deferred.isDone`, **`Deferred.await(d)`** (exported via `_await`, used as `Deferred.await`).

---

## 4. Gotchas & uncertainties

### Materially changed from 3.x (must rewrite)

**Core / Effect:**
- **`Effect.Service` and `Context.Tag` removed** → `class X extends Context.Service<X, Shape>()("id", { make? }) {}`. **No auto `.Default`/`.layer` static** — build with `Layer.effect(X, X.make)`. (Greps found no `.Default`/`.layer`/`.toLayer` static.)
- **`Effect.fork` removed** → `Effect.forkChild` / `forkScoped` (now takes options) / `forkIn` / `forkDetach` (replaces `forkDaemon`).
- **`Effect.zipRight` / `zipLeft` removed** → `Effect.andThen` / `Effect.tap` / `Effect.zip(self, that, { concurrent? })`.
- **`Effect.timeoutFail` removed** → `Effect.timeout(duration)` (fails `Cause.TimeoutError`, NOT 3.x `TimeoutException`) + `mapError`, OR `Effect.timeoutOrElse({ duration, orElse })`, OR `Effect.timeoutOption`.
- `Effect.provide` / `Layer.provide` / `Layer.provideMerge` now also accept a **tuple/array of layers**.
- `Effect.acquireRelease` release callback signature is `(value, exit)` (2nd param available; optional to ignore).
- **`unsafeX` → `Xunsafe`** naming everywhere (`makeUnsafe`, `closeUnsafe`, `getUnsafe`).
- `Schedule` gained type params: `Schedule<Output, Input, Error, Env>` (new 3rd `Error` channel). Simple `Schedule.spaced(d)` is still `Schedule<number>`.
- `Context.empty` is now a function (`Context.empty()`); `Option.none` is a function (`Option.none()`).
- No standalone `Layer.scoped` — scoped layers go through `Layer.effect` (the effect's `Scope.Scope` requirement is discharged automatically).
- `Scope.extend` removed → `Scope.provide` / `Scope.use`.

**PubSub / Stream / Queue:**
- `PubSub.subscribe` yields `Subscription<A>` not `Dequeue<A>`; consume with `PubSub.take` not `Queue.take`.
- `Stream.fromPubSub(pubsub)` takes a bare PubSub (no Scope, no `{ scoped }`); new `Stream.fromSubscription(sub)`.
- `Stream.unwrapScoped` removed → `Stream.unwrap`. `Stream.scoped` now takes a Stream (not Effect).
- `Stream.fromArray` is the canonical array constructor (`fromIterable` still exists).
- Queues carry a typed `E`/`Cause.Done` channel (replaces shutdown-interruption model).

**Schema:**
- Import root `@effect/schema` → `import { Schema } from "effect"`. `effect/unstable/schema` is DB Models, NOT contracts.
- `Schema.parseJson(s)` → `Schema.fromJsonString(s)`; no-arg → `Schema.UnknownFromJsonString`.
- `Schema.Union(A, B)` → `Schema.Union([A, B])` (array). Multi-literal: `Schema.Literals([...])`.
- **`Schema.decode` / `Schema.encode` changed meaning** — now transformation combinators, NOT runners. They still exist, so verbatim 3.x copies will silently mis-migrate. Use `decodeSync`/`decodeEffect`/`decodeUnknownSync`/`encodeSync`/… instead.
- `decodeUnknownEither` removed → `decodeUnknownResult` (`Result<A, Issue>`) or `*Exit`. Error type is `SchemaError` (not `ParseError`); guard `Schema.isSchemaError`.
- `Schema.optional` → mostly `Schema.optionalKey`. Encoded-type helper moved: `Schema.Schema.Encoded` → `Schema.Codec.Encoded`. `Schema.TaggedError` → `Schema.ErrorClass`/`TaggedErrorClass`. Class constructors throw `SchemaError` (was `ParseError`).

**RPC / Socket / HTTP:**
- `@effect/rpc` package gone → `effect/unstable/rpc`; Socket/HTTP → `effect/unstable/socket`, `effect/unstable/http`.
- v4 standardizes inline `Rpc.make("Tag", { payload, success, error, stream, defect?, primaryKey? })`. New `Rpc.custom`, `Rpc.fork`, `Rpc.uninterruptible`, `Rpc.wrap`.
- Handler fn gained 2nd arg `{ client, requestId, headers, rpc }`.
- WS server: `RpcServer.layerProtocolWebsocket({ path })` (lowercase `s`). Client WS: `RpcClient.layerProtocolSocket()` + WS `Socket` (no `layerProtocolWebsocket` on client). `BunHttpServer.layer` takes raw `Bun.serve` options.
- **Casing pitfall:** server export is `layerProtocolWebsocket` (lowercase s) while Socket service classes are `WebSocket`/`WebSocketConstructor` (capital S).
- HttpRouter favors layer-oriented `HttpRouter.add`/`addAll` + `HttpRouter.serve(appLayer)`. Socket errors are Schema-backed tagged classes.

**CLI:**
- `Options` → `Flag`, `Args` → `Argument`. `Command.run` dropped `name` (now `{ version }` only; name from the root command). `(argv) => Effect` form is now `Command.runWith`. Env layer `BunContext`/`NodeContext` → `BunServices.layer`. `Args.text({name})` → `Argument.string("name")`; `Args.repeated` → `Argument.variadic`.

**Platform-Bun / SQL / FileSystem:**
- `@effect/platform/FileSystem`/`Path`/`Error` → core `effect/FileSystem`, `effect/Path`, `effect/PlatformError`. `@effect/sql/*` → `effect/unstable/sql/*`.
- **No `BunContext`** → `BunServices.layer` (narrower: FS+Path+Crypto+Terminal+Stdio+ChildProcessSpawner; NO HTTP/socket/worker/Redis).
- `BunRuntime.runMain` type accepts only `{ disableErrorReporting, teardown }` — **do NOT pass `disablePrettyLogger`** (in 3.x and in v4's doc comment, but absent from the v4 type → type error).
- `SqliteClient.layer` self-provides `Reactivity`; provides both `SqliteClient` and `SqlClient`. WAL on by default (disable via `disableWAL: true`). `sql.updateValues`/`.stream` unsupported on Bun SQLite. `SqlError` is a structured `Schema.Class`.

**DevTools (TS / vitest / depcruise):**
- TS 6.0: `moduleResolution: "classic"` removed (use `bundler`); new default `target` floats to `es2025`, `types` defaults to `[]`, `strict`/`module: esnext`/`moduleResolution: bundler` defaulted — the plan pins these explicitly so changes are inert. **`skipLibCheck: true` is load-bearing** (effect v4 `.d.ts` does not survive strict lib check under `lib: ["ES2022"]`; ~40 errors). New TS5112 diagnostic for ad-hoc `tsc file.ts` with a tsconfig present (use `--ignoreConfig`); does not affect project-mode `tsc --noEmit`.
- effect v4 `.d.ts` import internal modules with explicit `.ts` extensions — `moduleResolution: "bundler"` (or `nodenext`) resolves these; `node`/`classic` would not. No `allowImportingTsExtensions` needed for consuming effect.
- vitest 4 requires Vite `^6 || ^7 || ^8` (installed 8.0.14 ✓) + Node ≥20. `workspace` → `projects`; `poolOptions` flattened (`maxThreads`/`maxForks` → `maxWorkers`; `singleThread`/`singleFork` → `maxWorkers: 1` + `isolate: false`); `coverage.all` removed; removed reporter lifecycle hooks. `defineConfig`, `test.include`, `resolve.alias` unchanged. Add `resolve.alias` for `@yodea` (tsconfig `paths` aren't read at runtime). Default test glob: `**/*.{test,spec}.?(c|m)[jt]s?(x)`.
- dependency-cruiser 17.4.2: forbidden-rule shape, `tsConfig`, `tsPreCompilationDeps`, `doNotFollow`, `exclude`, and `depcruise … --config` CLI all unchanged from 16. No `defineConfig` export — use JSDoc `@type {import('dependency-cruiser').IConfiguration}`. Supports `typescript >=2.0.0 <7.0.0` (TS 6.0.3 OK). Optional speed: `options.skipAnalysisNotInRules: true`. `forceDeriveDependents` is a no-op; `viaNot`/`viaSomeNot` deprecated.

### Unconfirmed — implementer must verify

1. **Exact `@effect/platform-bun` and `@effect/sql-sqlite-bun` version pins** — not quoted anywhere; read from their `package.json`.
2. **`Layer.launch`** signature/name was not directly opened in the RPC report (used in the server snippet); CORE report confirms `Layer.launch(self): Effect<never, E, RIn>` exists in `Layer.d.ts` — treat as confirmed, but the RPC author flagged it. Safe.
3. **`BunSocket.layerWebSocket` fully satisfying `WebSocketConstructor`** — `.d.ts` declares `Layer<Socket, never, never>` (implies yes); the `.js` internals were not read.
4. **Multiple `Stream.fromPubSub(pubsub)` on the same PubSub** — source shows each run independently subscribes; fan-out timing/back-pressure and exact finalizer-release ordering on interrupt were not runtime-verified.
5. **`Queue.take` precise failure value** when a PubSub-backed flow ends (`Cause.done()` path → stream completion vs failure not fully traced).
6. **`Schema.fromJsonString` `JSON.stringify` options** (replacer/space) — not visible in the signature.
7. **`AST.ParseOptions` full key set** (e.g. `errors: "all" | "first"`, `onExcessProperty`) — present as `options?` but not enumerated.
8. **CLI handler returning non-`void`** — not supported by the typed overloads; `Param.VariadicParamOptions` beyond `{ min, max }` not read; grouped-subcommand `{ group, commands }` form type-checks but was not runtime-verified.
9. **`Command.run` argv slicing** (Bun.argv vs process.argv leading-entry handling) — observed correct end-to-end but internals not traced.
10. **`SqliteClientConfig` flag mapping** (`readonly`/`create`/`readwrite` → `bun:sqlite`) — field presence authoritative, full `make` body not dumped.
11. **`BunRuntime.runMain` `disablePrettyLogger`** — excluded from the type; whether it's silently accepted at runtime was not tested (do not rely on it).
12. **No report conflicts found.** The one cross-report consistency point worth noting: CORE confirms `Layer.launch` exists (RPC report flagged it as unverified-in-session) — these do not conflict; `Layer.launch` is confirmed.