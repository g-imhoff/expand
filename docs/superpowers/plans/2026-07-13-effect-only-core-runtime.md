# Effect-Only Core Runtime and SDK Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove hidden ambient effects and synchronous failure from contracts, the client SDK, CLI composition, and the backend core while preserving all public behavior and lock-protocol guarantees.

**Architecture:** Contracts expose pure path derivation and explicit services without ambient defaults. Node entry adapters acquire the host values Effect does not model. Backend command selection, process probing, identity/time generation, and project synchronization become typed Effects. Both lock algorithms retain their hard-link, inode, token, fsync, and stale-owner protocols while moving onto Effect services inside uninterruptible transactions. A final pass gives every reusable named Effect operation an `Effect.fn` boundary.

**Tech Stack:** TypeScript 6.0.3, Effect 4.0.0-beta.74, `@effect/platform-node` beta 74, `@effect/vitest` beta 74, Vitest 4.1, Node.js 24.15, npm 11.

## Global Constraints

- Execute after `2026-07-13-effect-only-audit-foundation.md` is complete and committed.
- Run `npm run effect:audit:update` after each task only after the code and focused tests pass. The update must refuse additions and remove only findings fixed by that task.
- Keep deterministic folds, schemas, predicates, formatting, path calculations over supplied inputs, and lock-record equality pure.
- Use `Effect.try` for Node host calls that can throw. Use Effect services for filesystem, path, time, randomness, configuration, and retries.
- NodeServices does not model home-directory lookup, current PID, `process.kill(pid, 0)`, `execPath`, or umask. Keep those operations in exact registered Node adapters with typed failure.
- Treat `EPERM` from a signal-0 process probe as inaccessible but alive, `ESRCH` as dead, and every other error as typed unknown failure.
- Preserve atomic hard-link publication, fsync before publication, device/inode comparison, token comparison, legacy-record compatibility, and cleanup under interruption.
- Do not add code comments.
- Every task is implemented by a fresh project `tdd-implementer`, then reviewed by a fresh project `task-reviewer`. Send all Critical and Important findings through one fresh fix wave and repeat the gate before continuing.
- Never dispatch parallel tracked-tree writers.

---

## File responsibility map

- `packages/contracts/app-context.ts`: pure AppContext derivation plus a required Context service.
- `packages/contracts/process-control.ts`: platform-neutral current-process and liveness contract.
- `packages/client-ts/backend-command.ts`: Config, Schema, and FileSystem command selection.
- `packages/client-ts/discovery.ts`: endpoint validation through `ProcessControl`.
- `packages/client-ts/spawn-lock.ts`: Effect FileSystem coordination transaction.
- `apps/server/state-root-lock.ts`: Effect FileSystem single-backend transaction and startup handoff.
- `apps/server/lib/ids.ts`: Crypto-backed identifiers.
- `apps/server/application/projects/use-cases.ts`: Clock-backed event timestamps.
- `apps/server/composition/app.ts`: lazy server token, explicit process identity, and named server program.
- `packages/contracts/project-sync.ts`: Effect-valued synchronization sink.
- `eslint-rules/effect-host-boundaries.mjs`: exact surviving Node host seams only.

---

### Task 1: Split pure AppContext derivation from Node host acquisition

**Files:**
- Modify: `packages/contracts/app-context.ts`
- Modify: `packages/contracts/test/app-context.test.ts`
- Modify: `apps/cli/cli/app-context-layer.ts`
- Create: `apps/cli/cli/node-app-context.ts`
- Create: `apps/server/node-app-context.ts`
- Create: `apps/tui/node-app-context.ts`
- Create: `apps/desktop/src/main/node-app-context.ts`
- Create: `examples/client-ts/node-app-context.ts`
- Modify: `apps/cli/cli/main.ts`
- Modify: `apps/server/main.ts`
- Modify: `apps/tui/runtime.ts`
- Modify: `apps/desktop/src/main/runtime.ts`
- Modify: `examples/client-ts/adapter.ts`
- Modify: `bench/scenarios/server-e2e.ts`
- Modify: `apps/server/test/integration/change-directory-e2e.test.ts`
- Modify: `apps/server/test/integration/concurrency.test.ts`
- Modify: `apps/server/test/integration/connect-during-shutdown.test.ts`
- Modify: `apps/server/test/integration/delete-e2e.test.ts`
- Modify: `apps/server/test/integration/durability-restart.test.ts`
- Modify: `apps/server/test/integration/e2e-lifecycle.test.ts`
- Modify: `apps/server/test/integration/endpoint-file.test.ts`
- Modify: `apps/server/test/integration/events-replay.test.ts`
- Modify: `apps/server/test/integration/ops-lifecycle.test.ts`
- Modify: `apps/server/test/integration/set-metadata.test.ts`
- Modify: `apps/server/test/integration/trust-boundary.test.ts`
- Modify: `packages/client-ts/test/integration/acquire-client.test.ts`
- Modify: `packages/client-ts/test/integration/client-session.test.ts`
- Modify: `packages/client-ts/test/integration/discovery.test.ts`
- Modify: `packages/client-ts/test/integration/find-or-spawn.test.ts`
- Modify: `packages/client-ts/test/integration/node-adapter.test.ts`
- Modify: `packages/client-ts/test/integration/project-sync.test.ts`
- Modify: `packages/client-ts/test/integration/spawn-lock.test.ts`

**Interfaces:**
- Replaces: ambient `defaultDataDir(channel?)` and `makeAppContext(dataDir?, channel?)`.
- Produces: pure `defaultDataDir(path, homeDir, channel)` and `makeAppContext(path, input)`.
- Produces: required `AppContext` service with no `Context.Reference` default.
- Produces: one exact `nodeAppContext` Effect adapter per Node application boundary.

- [ ] **Step 1: Write failing pure derivation and missing-service tests**

Replace ambient tests with fixed inputs and add a type/runtime test that an unprovided `AppContext` remains in the Effect environment:

```ts
it.effect("derives every path from explicit host inputs", () =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    expect(makeAppContext(path, {
      homeDir: "/home/test",
      cwd: "/work",
      dataDir: "state",
      channel: "dev"
    })).toEqual({
      channel: "dev",
      paths: {
        dataDir: "/work/state",
        dbPath: "/work/state/events.db",
        endpointFile: "/work/state/server.json",
        logDir: "/work/state/logs",
        spawnLockFile: "/work/state/server.json.lock"
      }
    })
  }).pipe(Effect.provide(NodeServices.layer)))

const appContextProgram = Effect.gen(function*() {
  return yield* AppContext
})
expectTypeOf(appContextProgram).toMatchTypeOf<Effect.Effect<AppContextShape, never, AppContext>>()
```

Add default dev/release path, relative/absolute data-dir, and coordination-lock cases. The test must not inspect the executing user's home, cwd, or argv.

- [ ] **Step 2: Verify the red state**

Run:

```bash
npm exec -- vitest run packages/contracts/test/app-context.test.ts
```

Expected: FAIL because the current functions read `homedir`, `process.argv`, and ambient cwd and `AppContext` has a default.

- [ ] **Step 3: Implement the pure contract and required service**

Use these exact public shapes:

```ts
export interface AppContextPathOps {
  readonly join: (...paths: ReadonlyArray<string>) => string
  readonly resolve: (...paths: ReadonlyArray<string>) => string
}

export interface AppContextInput {
  readonly homeDir: string
  readonly cwd: string
  readonly dataDir?: string
  readonly channel?: Channel
}

export class AppContext extends Context.Service<AppContext, AppContextShape>()(
  "expand/AppContext"
) {}

export const defaultDataDir = (
  path: AppContextPathOps,
  homeDir: string,
  selectedChannel: Channel = channel
): string => path.join(homeDir, NAMES.home, NAMES.channel[selectedChannel])

export const makeAppContext = (
  path: AppContextPathOps,
  input: AppContextInput
): AppContextShape => {
  const selectedChannel = input.channel ?? channel
  const fallback = path.resolve(input.cwd, defaultDataDir(path, input.homeDir, selectedChannel))
  const base = path.resolve(input.cwd, input.dataDir ?? fallback)
  return { channel: selectedChannel, paths: derivePaths(path, input.homeDir, base, fallback, selectedChannel) }
}
```

`packages/contracts/app-context.ts` must have no Node import and no process access.

- [ ] **Step 4: Add exact Node acquisition Effects and update all providers**

Each application adapter acquires `homedir()` and `process.cwd()` with `Effect.try`, obtains `Path.Path`, accepts selected data-dir/argv explicitly, and returns an `AppContextShape` or layer. The shared shape is:

```ts
export const nodeAppContext = Effect.fn("NodeAppContext.make")(function*(dataDir?: string) {
  const path = yield* Path.Path
  const homeDir = yield* Effect.try({ try: homedir, catch: toHostContextError })
  const cwd = yield* Effect.try({ try: () => process.cwd(), catch: toHostContextError })
  return makeAppContext(path, { homeDir, cwd, dataDir })
})
```

Register each exact `homedir`/cwd adapter declaration in `effect-host-boundaries.mjs`; do not exempt its whole file. Update CLI flags, server argv parsing, desktop/TUI/example runtimes, benchmarks, E2E helpers, and every test layer to provide `AppContext` explicitly. `ClientLayer` must now expose `AppContext` in its required environment instead of relying on the old default.

- [ ] **Step 5: Verify behavior and architecture**

Run:

```bash
npm exec -- vitest run packages/contracts/test/app-context.test.ts apps/cli/test/contract/contract.test.ts packages/client-ts/test/integration/discovery.test.ts
npm run typecheck:all
npm run arch
npm run effect:audit:update
npm run effect:audit
```

Expected: PASS; no contracts file imports Node or reads ambient state; all runtime compositions provide `AppContext` explicitly.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/app-context.ts packages/contracts/test/app-context.test.ts apps/cli/cli/app-context-layer.ts apps/cli/cli/node-app-context.ts apps/server/node-app-context.ts apps/tui/node-app-context.ts apps/desktop/src/main/node-app-context.ts examples/client-ts/node-app-context.ts apps/cli/cli/main.ts apps/server/main.ts apps/tui/runtime.ts apps/desktop/src/main/runtime.ts examples/client-ts/adapter.ts bench/scenarios/server-e2e.ts apps/server/test packages/client-ts/test apps/desktop/e2e/helpers.ts eslint-rules/effect-host-boundaries.mjs effect-audit-baseline.json effect-grep-inventory.json
git commit -m "refactor: make app context explicit"
```

---

### Task 2: Make backend command resolution Effect-native

**Files:**
- Modify: `packages/client-ts/backend-command.ts`
- Modify: `packages/client-ts/errors.ts`
- Modify: `packages/client-ts/index.ts`
- Modify: `packages/client-ts/adapters/node.ts`
- Modify: `packages/client-ts/test/unit/resolve-backend-command.test.ts`
- Modify: `packages/client-ts/test/unit/adapter-spawn-errors.test.ts`
- Modify: `packages/client-ts/test/unit/entrypoints.test.ts`
- Modify: `apps/cli/cli/main.ts`
- Modify: `apps/tui/runtime.ts`
- Modify: `apps/desktop/src/main/runtime.ts`
- Modify: `examples/client-ts/adapter.ts`

**Interfaces:**
- Produces: tagged `BackendCommandError` with reasons `invalid-override`, `source-check-failed`, and `not-configured`.
- Changes: `resolveBackendCommand(options)` to `Effect<ReadonlyArray<string>, BackendCommandError, FileSystem.FileSystem>`.
- Changes: `NodeAdapterOptions.backendCommand` from array-or-throwing-thunk to an Effect value.
- Consumes: `Config.option(Config.string("EXPAND_BACKEND_CMD"))`, Schema JSON decoding, explicit `execPath`, and `FileSystem.exists`.

- [ ] **Step 1: Write failing error-channel and precedence tests**

Use `it.effect` and `ConfigProvider.fromUnknown` to cover override, malformed JSON, non-string arrays, source existence, compiled fallback, filesystem failure, and no configured command:

```ts
it.effect("reports an invalid override in the typed error channel", () =>
  resolveBackendCommand({ execPath: "node", binaryArgs: ["fallback"] }).pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ EXPAND_BACKEND_CMD: "{" }))),
    Effect.flip,
    Effect.tap((error) => Effect.sync(() => expect(error.reason).toBe("invalid-override")))
  ))
```

Add a laziness test proving command resolution and filesystem access do not run when `makeNodeAdapter` is constructed.

- [ ] **Step 2: Verify the red state**

Run:

```bash
npm exec -- vitest run packages/client-ts/test/unit/resolve-backend-command.test.ts packages/client-ts/test/unit/adapter-spawn-errors.test.ts
```

Expected: FAIL because the current API throws and reads process/filesystem synchronously.

- [ ] **Step 3: Implement typed parsing and Effect selection**

Define:

```ts
export class BackendCommandError extends Data.TaggedError("BackendCommandError")<{
  readonly reason: "invalid-override" | "source-check-failed" | "not-configured"
  readonly detail: string
  readonly cause?: unknown
}> {}

const BackendCommandOverride = Schema.fromJsonString(
  Schema.Array(Schema.String).check(Schema.isNonEmpty())
)

export const resolveBackendCommand = Effect.fn("BackendCommand.resolve")(function*(
  options: ResolveBackendCommandOptions
) {
  const fs = yield* FileSystem.FileSystem
  const override = yield* Config.option(Config.string("EXPAND_BACKEND_CMD"))
  if (Option.isSome(override) && override.value !== "") {
    return yield* Schema.decodeUnknownEffect(BackendCommandOverride)(override.value).pipe(
      Effect.mapError((cause) => new BackendCommandError({ reason: "invalid-override", detail: cause.message, cause }))
    )
  }
  if (options.sourceEntry !== undefined && SOURCE_ENTRY_RE.test(options.sourceEntry)) {
    const exists = yield* fs.exists(options.sourceEntry).pipe(
      Effect.mapError((cause) => new BackendCommandError({ reason: "source-check-failed", detail: String(cause), cause }))
    )
    if (exists) return [options.execPath, ...(options.runtimeArgs ?? []), options.sourceEntry, ...(options.sourceArgs ?? [])]
  }
  if (options.binaryArgs !== undefined && options.binaryArgs.length > 0) return options.binaryArgs
  return yield* Effect.fail(new BackendCommandError({ reason: "not-configured", detail: "no backend command configured" }))
})
```

Make `execPath` required whenever source mode is configured; Node entry adapters obtain it at their exact host boundary. Map `BackendCommandError` once to `BackendUnavailable` in the spawn adapter.

- [ ] **Step 4: Replace every throwing command thunk with an Effect**

Use `Effect.suspend(() => resolveBackendCommand(...))` when command path calculation must be lazy. Update CLI, TUI, desktop, examples, entrypoint type tests, and public exports. Propagate the FileSystem requirement through `RuntimeAdapter.spawnBackend` and `ClientLayer` until Stage 3 adds ChildProcessSpawner.

- [ ] **Step 5: Verify focused and package behavior**

Run:

```bash
npm exec -- vitest run packages/client-ts/test/unit/resolve-backend-command.test.ts packages/client-ts/test/unit/adapter-spawn-errors.test.ts packages/client-ts/test/unit/entrypoints.test.ts
npm run build --workspace @expand/client-ts
npm run typecheck:all
npm run effect:audit:update
npm run effect:audit
```

Expected: PASS; no public backend-command path throws, reads `process.env`, or calls `existsSync`.

- [ ] **Step 6: Commit**

```bash
git add packages/client-ts/backend-command.ts packages/client-ts/errors.ts packages/client-ts/index.ts packages/client-ts/adapters/node.ts packages/client-ts/test/unit apps/cli/cli/main.ts apps/tui/runtime.ts apps/desktop/src/main/runtime.ts examples/client-ts/adapter.ts effect-audit-baseline.json effect-grep-inventory.json
git commit -m "refactor: resolve backend commands with Effect"
```

---

### Task 3: Add explicit process control and make discovery effectful

**Files:**
- Create: `packages/contracts/process-control.ts`
- Create: `packages/contracts/test/process-control.test.ts`
- Create: `packages/client-ts/adapters/node-process-control.ts`
- Create: `apps/server/node-process-control.ts`
- Modify: `packages/client-ts/discovery.ts`
- Modify: `packages/client-ts/spawn.ts`
- Modify: `packages/client-ts/rpc-client.ts`
- Modify: `packages/client-ts/client-layer.ts`
- Modify: `packages/client-ts/index.ts`
- Modify: `packages/client-ts/test/integration/discovery.test.ts`
- Modify: `packages/client-ts/test/integration/find-or-spawn.test.ts`
- Modify: `packages/client-ts/test/integration/client-layer.test.ts`
- Modify: `packages/client-ts/adapter.ts`
- Modify: `packages/client-ts/adapters/node.ts`
- Modify: `packages/client-ts/client-session.ts`
- Modify: `packages/client-ts/project/client.ts`
- Modify: `packages/client-ts/rpc-client.ts`
- Modify: `packages/client-ts/server/client.ts`
- Modify: `packages/client-ts/with-client.ts`
- Modify: `packages/client-ts/test/integration/acquire-client.test.ts`
- Modify: `packages/client-ts/test/integration/client-session.test.ts`
- Modify: `packages/client-ts/test/integration/node-adapter.test.ts`
- Modify: `packages/client-ts/test/integration/project-sync.test.ts`
- Modify: `packages/client-ts/test/integration/spawn-lock.test.ts`
- Modify: `packages/client-ts/test/unit/adapter-spawn-errors.test.ts`
- Modify: `packages/client-ts/test/unit/entrypoints.test.ts`
- Modify: `apps/cli/cli/main.ts`
- Modify: `apps/desktop/src/main/runtime.ts`
- Modify: `apps/desktop/test/integration/connection-honesty.test.ts`
- Modify: `apps/desktop/test/integration/rpc-handlers.test.ts`
- Modify: `apps/desktop/test/integration/rpc-server.test.ts`
- Modify: `apps/desktop/test/integration/transport.test.ts`
- Modify: `apps/tui/runtime.ts`
- Modify: `examples/client-ts/adapter.ts`
- Modify: `examples/client-ts/archive-stale.ts`
- Modify: `examples/client-ts/audit-log.ts`
- Modify: `examples/client-ts/bootstrap-projects.ts`
- Modify: `bench/scenarios/server-e2e.ts`
- Modify: `apps/server/test/integration/change-directory-e2e.test.ts`
- Modify: `apps/server/test/integration/concurrency.test.ts`
- Modify: `apps/server/test/integration/connect-during-shutdown.test.ts`
- Modify: `apps/server/test/integration/delete-e2e.test.ts`
- Modify: `apps/server/test/integration/durability-restart.test.ts`
- Modify: `apps/server/test/integration/e2e-lifecycle.test.ts`
- Modify: `apps/server/test/integration/events-replay.test.ts`
- Modify: `apps/server/test/integration/ops-lifecycle.test.ts`
- Modify: `apps/server/test/integration/set-metadata.test.ts`
- Modify: `apps/server/test/integration/trust-boundary.test.ts`

**Interfaces:**
- Produces: `ProcessControl` service, `ProcessStatus`, and tagged `ProcessProbeError`.
- Changes: `readEndpoint` requirement to `FileSystem.FileSystem | AppContext | ProcessControl`.
- Changes: `ClientLayer` requirement to include `AppContext | ProcessControl` explicitly.
- Produces: exact Node process-control layers for client applications and server startup.

- [ ] **Step 1: Write failing deterministic probe tests**

Use a fake service and cover alive, dead, inaccessible, and unknown outcomes:

```ts
export type ProcessStatus = "alive" | "dead" | "inaccessible"

it.effect("treats an inaccessible endpoint owner as alive", () =>
  readEndpoint.pipe(
    Effect.provideService(ProcessControl, {
      currentPid: 100,
      probe: () => Effect.succeed("inaccessible")
    }),
    Effect.tap((endpoint) => Effect.sync(() => expect(Option.isSome(endpoint)).toBe(true)))
  ))

it.effect("does not turn an unknown probe failure into a stale endpoint", () =>
  readEndpoint.pipe(
    Effect.provideService(ProcessControl, failingProbe),
    Effect.flip,
    Effect.tap((error) => Effect.sync(() => expect(error._tag).toBe("ProcessProbeError")))
  ))
```

- [ ] **Step 2: Verify the red state**

Run:

```bash
npm exec -- vitest run packages/contracts/test/process-control.test.ts packages/client-ts/test/integration/discovery.test.ts
```

Expected: FAIL because the service does not exist and discovery hides `process.kill` in a boolean.

- [ ] **Step 3: Implement the platform-neutral service and exact Node adapters**

Define:

```ts
export type ProcessStatus = "alive" | "dead" | "inaccessible"

export class ProcessProbeError extends Data.TaggedError("ProcessProbeError")<{
  readonly pid: number
  readonly cause: unknown
}> {}

export interface ProcessControlShape {
  readonly currentPid: number
  readonly probe: (pid: number) => Effect.Effect<ProcessStatus, ProcessProbeError>
}

export class ProcessControl extends Context.Service<ProcessControl, ProcessControlShape>()(
  "expand/ProcessControl"
) {}
```

Node adapters use `Effect.try({ try: () => process.kill(pid, 0), catch: (cause) => cause })`; map `ESRCH` to `dead`, `EPERM` to `inaccessible`, success to `alive`, and every other error to `ProcessProbeError`. Capture `process.pid` only in the exact layer factory. Register those declarations, not their files.

- [ ] **Step 4: Thread the service through discovery and composition**

Make `readEndpoint` fail with `ProcessProbeError` rather than silently declaring an unknown owner dead. Update `findOrSpawnBackend`, acquisition/session layers, adapters, and all test providers. Server and lock work in later tasks consumes the same contract.

- [ ] **Step 5: Verify discovery and layer composition**

Run:

```bash
npm exec -- vitest run packages/client-ts/test/integration/discovery.test.ts packages/client-ts/test/integration/find-or-spawn.test.ts packages/client-ts/test/integration/client-layer.test.ts
npm run typecheck:all
npm run effect:audit:update
npm run effect:audit
```

Expected: PASS; process-probe failure is typed and fail-closed; no core discovery helper accesses `process`.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/process-control.ts packages/contracts/test/process-control.test.ts packages/client-ts/adapters/node-process-control.ts apps/server/node-process-control.ts packages/client-ts/discovery.ts packages/client-ts/spawn.ts packages/client-ts/rpc-client.ts packages/client-ts/client-layer.ts packages/client-ts/index.ts packages/client-ts/test apps/cli apps/tui/runtime.ts apps/desktop/src/main examples/client-ts bench apps/server/test eslint-rules/effect-host-boundaries.mjs effect-audit-baseline.json effect-grep-inventory.json
git commit -m "refactor: make process probes explicit"
```

---

### Task 4: Move server identities and timestamps into Crypto and Clock

**Files:**
- Modify: `apps/server/lib/ids.ts`
- Modify: `apps/server/application/projects/use-cases.ts`
- Modify: `apps/server/composition/app.ts`
- Modify: `apps/server/main.ts`
- Modify: `apps/server/test/unit/ids.test.ts`
- Modify: `apps/server/test/application/create-project.test.ts`
- Modify: `apps/server/test/application/rename-project.test.ts`
- Modify: `apps/server/test/integration/use-cases.test.ts`
- Modify: `apps/server/test/integration/set-metadata.test.ts`
- Modify: `apps/server/test/integration/endpoint-file.test.ts`
- Modify: `apps/server/test/integration/trust-boundary.test.ts`

**Interfaces:**
- Changes: `newId()` from `string` to `Effect<string, PlatformError, Crypto.Crypto>`.
- Changes: project mutation construction to depend on `Crypto.Crypto` and Clock-backed `DateTime.now`.
- Changes: `runServer` to generate the token and read `ProcessControl.currentPid` only when its Effect executes.
- Preserves: event/project ISO string fields and public RPC result shapes.

- [ ] **Step 1: Write failing deterministic identity, clock, and laziness tests**

Provide `Crypto.make` with fixed bytes and `TestClock` at fixed instants. Prove IDs are fresh per invocation, all timestamps in one event agree, later mutations see adjusted time, and creating `runServer(options)` performs no Crypto or process access before execution:

```ts
it.effect("uses the Effect clock for project event time", () =>
  Effect.gen(function*() {
    yield* TestClock.setTime(1783936800000)
    const created = yield* ProjectUseCases.createProject("alpha", false)
    expect(created.project.createdAt).toBe("2026-07-13T10:00:00.000Z")
    expect(created.project.updatedAt).toBe(created.project.createdAt)
  }).pipe(Effect.provide(testUseCaseLayer)))
```

- [ ] **Step 2: Verify the red state**

Run:

```bash
npm exec -- vitest run apps/server/test/unit/ids.test.ts apps/server/test/application/create-project.test.ts apps/server/test/application/rename-project.test.ts apps/server/test/integration/use-cases.test.ts apps/server/test/integration/set-metadata.test.ts
```

Expected: FAIL because IDs and timestamps use ambient globals and the server token is eager.

- [ ] **Step 3: Implement Crypto and Clock effects**

Use:

```ts
export const newId = Effect.fn("Ids.newId")(function*() {
  const crypto = yield* Crypto.Crypto
  return yield* crypto.randomUUIDv4
})

const nowIso = Effect.map(DateTime.now, DateTime.formatIso)
```

Inside `ProjectUseCases.make`, define reusable `commit`, `validateDirectory`, and mutation operations with `Effect.fn`. Yield a fresh ID and timestamp inside each permitted mutation. Keep pure validation and folds unchanged. Preserve Crypto `PlatformError` as infrastructure failure in the declared service error rather than hiding it with `orDie` unless the server composition explicitly chooses to die at its outer boundary.

- [ ] **Step 4: Make server startup identity lazy and explicit**

Turn `runServer` into `Effect.fn("Server.run")`. Yield `newId` and the `ProcessControl` service inside execution, read `currentPid` from that service, then construct the transport layer with the generated token. Replace direct `dirname` with `Path.Path`. Keep endpoint serialization and logging behavior unchanged.

- [ ] **Step 5: Verify deterministic server behavior**

Run:

```bash
npm exec -- vitest run apps/server/test/unit/ids.test.ts apps/server/test/application/create-project.test.ts apps/server/test/application/rename-project.test.ts apps/server/test/integration/use-cases.test.ts apps/server/test/integration/set-metadata.test.ts apps/server/test/integration/endpoint-file.test.ts apps/server/test/integration/trust-boundary.test.ts
npm run typecheck:all
npm run effect:audit:update
npm run effect:audit
```

Expected: PASS; no production server ID/time/token/PID read happens outside Effect.

- [ ] **Step 6: Commit**

```bash
git add apps/server/lib/ids.ts apps/server/application/projects/use-cases.ts apps/server/composition/app.ts apps/server/main.ts apps/server/test effect-audit-baseline.json effect-grep-inventory.json
git commit -m "refactor: inject server identity and time"
```

---

### Task 5: Rebuild the spawn lock on Effect FileSystem

**Files:**
- Modify: `packages/client-ts/spawn-lock.ts`
- Modify: `packages/client-ts/spawn.ts`
- Modify: `packages/client-ts/errors.ts`
- Modify: `packages/client-ts/test/integration/spawn-lock.test.ts`
- Modify: `packages/client-ts/test/fixtures/spawn-lock-contender.ts`
- Modify: `packages/client-ts/test/integration/find-or-spawn.test.ts`

**Interfaces:**
- Produces: tagged `SpawnLockError` for filesystem, crypto, digest, schema, and probe failures.
- Changes: `acquireSpawnLock` requirement to `FileSystem | Path | Crypto | ProcessControl` with a typed error.
- Changes: test hooks from throwing `() => void` callbacks to Effect-valued hooks.
- Preserves: `undefined` only for valid contention or an unreclaimable observed owner, never for an unexpected platform failure.

- [ ] **Step 1: Add failing service, failure-channel, and interruption tests**

Keep the existing 64-process, stale/live/EPERM, legacy owner, complete publication, delayed observation, replacement release/reclaim, malformed record, mode, and path-independence cases. Add:

```ts
it.effect("reports unexpected filesystem failure instead of pretending contention", () =>
  acquireSpawnLock("/state/backend.lock").pipe(
    Effect.provide(FileSystem.layerNoop({
      makeDirectory: () => Effect.fail(permissionDenied)
    })),
    Effect.flip,
    Effect.tap((error) => Effect.sync(() => expect(error._tag).toBe("SpawnLockError")))
  ))

it.effect("removes candidate and claim files when interrupted", () =>
  runInterruptedLockScenario.pipe(
    Effect.tap((remaining) => Effect.sync(() => expect(remaining).toEqual([])))
  ))
```

- [ ] **Step 2: Verify the red state**

Run:

```bash
npm exec -- vitest run packages/client-ts/test/integration/spawn-lock.test.ts packages/client-ts/test/integration/find-or-spawn.test.ts
```

Expected: new failure/interruption cases FAIL against the whole-operation `Effect.sync` implementation.

- [ ] **Step 3: Implement Schema records and Effect filesystem primitives**

Decode current and legacy records with Schema. Use `Path.dirname`, `FileSystem.makeDirectory/chmod/open/link/stat/readFileString/remove`, `File.writeAll`, `File.sync`, `Crypto.randomUUIDv4`, `Crypto.digest`, `Clock.currentTimeMillis`, and `ProcessControl.probe`.

The publication transaction must retain this order inside `Effect.uninterruptibleMask`: create candidate with `open(..., { flag: "wx", mode: 0o600 })`, write all bytes, fsync, chmod, run hook, hard-link to canonical, and always remove candidate. Reclaim must hard-link canonical to claim, chmod, re-read both records, compare record plus device/inode, remove canonical, and always remove claim.

- [ ] **Step 4: Propagate typed lock failure through backend spawning**

Map `SpawnLockError` to `BackendUnavailable` once in `findOrSpawnBackend`. Do not turn platform failures into contention. Convert test hooks to Effects so their errors and interruption participate in cleanup.

- [ ] **Step 5: Run the complete process-heavy lock gate**

Run:

```bash
npm exec -- vitest run packages/client-ts/test/integration/spawn-lock.test.ts packages/client-ts/test/integration/find-or-spawn.test.ts
npm run typecheck:all
npm run effect:audit:update
npm run effect:audit
```

Expected: PASS including serialized 64-process election and all cleanup-sensitive cases.

- [ ] **Step 6: Commit**

```bash
git add packages/client-ts/spawn-lock.ts packages/client-ts/spawn.ts packages/client-ts/errors.ts packages/client-ts/test/integration/spawn-lock.test.ts packages/client-ts/test/fixtures/spawn-lock-contender.ts packages/client-ts/test/integration/find-or-spawn.test.ts effect-audit-baseline.json effect-grep-inventory.json
git commit -m "refactor: move spawn lock to Effect"
```

---

### Task 6: Rebuild the state-root lock on Effect FileSystem

**Files:**
- Modify: `apps/server/state-root-lock.ts`
- Modify: `apps/server/main.ts`
- Modify: `apps/server/test/integration/state-root-lock.test.ts`
- Modify: `apps/server/test/fixtures/state-root-lock-contender.ts`
- Modify: `apps/server/test/integration/default-data-dir.test.ts`
- Modify: `apps/server/test/integration/change-directory-e2e.test.ts`
- Modify: `apps/server/test/integration/concurrency.test.ts`
- Modify: `apps/server/test/integration/connect-during-shutdown.test.ts`
- Modify: `apps/server/test/integration/delete-e2e.test.ts`
- Modify: `apps/server/test/integration/durability-restart.test.ts`
- Modify: `apps/server/test/integration/e2e-lifecycle.test.ts`
- Modify: `apps/server/test/integration/events-replay.test.ts`
- Modify: `apps/server/test/integration/ops-lifecycle.test.ts`
- Modify: `apps/server/test/integration/set-metadata.test.ts`
- Modify: `apps/server/test/integration/trust-boundary.test.ts`

**Interfaces:**
- Preserves: `StateRootLease`, `StateRootLockError.kind`, `stateRootLock`, and `stateRootLockForStartup` semantics.
- Changes: all lock operations to require `FileSystem | Path | Crypto | ProcessControl`; deadlines use `Clock`.
- Preserves: endpoint-advertised, live-owner, and handoff-timeout error kinds and replacement protections.

- [ ] **Step 1: Add failing deterministic timeout, failure, and interruption tests**

Use `TestClock` for retry/deadline behavior and a failing FileSystem for typed platform errors. Retain real multi-process election tests. Add an interrupted acquisition assertion that no candidate/reclaim path remains and an inaccessible-owner case that reports `live-owner`.

- [ ] **Step 2: Verify the red state**

Run:

```bash
npm exec -- vitest run apps/server/test/integration/state-root-lock.test.ts
```

Expected: new service and interruption assertions FAIL against direct synchronous Node calls.

- [ ] **Step 3: Implement the Effect lock protocol**

Use strict Schema codecs for `LockOwner`, `Path.resolve/join`, FileSystem hard links and scoped file handles, `Crypto.randomUUIDv4`, `Clock.currentTimeMillis`, `Effect.sleep`, and `ProcessControl.probe`. Keep create and reclaim atomic sections uninterruptible while allowing the startup retry sleep to remain interruptible. Map `PlatformError`, `ProcessProbeError`, and Schema failure once to `StateRootLockError` with the original cause retained.

- [ ] **Step 4: Preserve scoped ownership and startup handoff**

Keep both public scoped APIs as `Effect.acquireRelease`. Release must verify token, record, device, and inode before removal and must not delete a replacement owner's lock. Startup retries only `live-owner`; it stops immediately for advertised endpoint, other typed failure, interruption, or deadline.

- [ ] **Step 5: Run state-root and lifecycle gates**

Run:

```bash
npm exec -- vitest run apps/server/test/integration/state-root-lock.test.ts apps/server/test/integration/default-data-dir.test.ts apps/server/test/integration/e2e-lifecycle.test.ts apps/server/test/integration/connect-during-shutdown.test.ts
npm run typecheck:all
npm run effect:audit:update
npm run effect:audit
```

Expected: PASS with real process election, TestClock timeout, and cleanup evidence.

- [ ] **Step 6: Commit**

```bash
git add apps/server/state-root-lock.ts apps/server/main.ts apps/server/test/integration/state-root-lock.test.ts apps/server/test/fixtures/state-root-lock-contender.ts apps/server/test/integration/default-data-dir.test.ts apps/server/test/integration/e2e-lifecycle.test.ts apps/server/test/integration/connect-during-shutdown.test.ts effect-audit-baseline.json effect-grep-inventory.json
git commit -m "refactor: move state root lock to Effect"
```

---

### Task 7: Make project synchronization sinks Effect-valued

**Files:**
- Modify: `packages/contracts/project-sync.ts`
- Modify: `packages/contracts/test/project-sync.test.ts`
- Modify: `packages/client-ts/test/integration/project-sync.test.ts`
- Modify: `apps/tui/use-projects.ts`
- Modify: `apps/desktop/src/renderer/app/runtime.ts`
- Modify: `apps/desktop/src/renderer/features/projects/data/project-store.ts`
- Modify: `apps/desktop/test/integration/project-reconnect-sync.test.ts`

**Interfaces:**
- Changes: `ProjectSyncSink` callbacks from `void` to Effect.
- Changes: `runProjectSync` error/environment to union source and sink requirements.
- Produces: named `Effect.fn` boundaries for `runProjectSync`, `runEpochLoop`, and `runEpoch`.

- [ ] **Step 1: Write failing sink failure and interruption tests**

Add:

```ts
interface ProjectSyncSink<E = never, R = never> {
  readonly snapshot: (snapshot: ProjectSnapshot) => Effect.Effect<void, E, R>
  readonly status: (status: ProjectSyncStatus) => Effect.Effect<void, E, R>
}

it.effect("propagates sink failure through the synchronization effect", () =>
  runProjectSync(source, {
    snapshot: () => Effect.fail("sink-failed" as const),
    status: () => Effect.void
  }).pipe(
    Effect.flip,
    Effect.tap((error) => Effect.sync(() => expect(error).toBe("sink-failed")))
  ))
```

Add a Deferred-controlled callback and prove interruption stops it and closes the active epoch. Count source calls and prove a sink failure is propagated once rather than entering the source retry schedule.

- [ ] **Step 2: Verify the red state**

Run:

```bash
npm exec -- vitest run packages/contracts/test/project-sync.test.ts packages/client-ts/test/integration/project-sync.test.ts
```

Expected: FAIL because sink callbacks currently return void and are hidden in `Effect.sync`.

- [ ] **Step 3: Implement the generic Effect sink contract**

Use:

```ts
export interface ProjectSyncSink<E = never, R = never> {
  readonly snapshot: (snapshot: ProjectSnapshot) => Effect.Effect<void, E, R>
  readonly status: (status: ProjectSyncStatus) => Effect.Effect<void, E, R>
}

export const runProjectSync = Effect.fn("ProjectSync.run")(function*<ES, RS, EK, RK>(
  source: ProjectSyncSource<ES, RS>,
  sink: ProjectSyncSink<EK, RK>
) {
  return yield* Effect.scoped(runStatusLoop(source, sink))
})
```

Yield callbacks directly. Internally map source and sink errors into separate discriminated wrappers, apply the existing epoch retry schedule only to wrapped source failures, and unwrap both before returning from the public operation. This preserves arbitrary `ES | EK` values without retrying or swallowing a sink failure. Preserve one active epoch, sequence gating, reconnect resnapshot, interruption propagation, and source failure behavior. UI state setters remain small exact host adapters returning `Effect.sync` until Stage 3 gives them owned framework runners.

- [ ] **Step 4: Update every sink implementation and verify**

Run:

```bash
npm exec -- vitest run packages/contracts/test/project-sync.test.ts packages/client-ts/test/integration/project-sync.test.ts apps/desktop/test/integration/project-reconnect-sync.test.ts
npm run typecheck:all
npm run effect:audit:update
npm run effect:audit
```

Expected: PASS; no sink callback failure is hidden behind a void signature.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/project-sync.ts packages/contracts/test/project-sync.test.ts packages/client-ts/test/integration/project-sync.test.ts apps/tui/use-projects.ts apps/desktop/src/renderer/app/runtime.ts apps/desktop/src/renderer/features/projects/data/project-store.ts apps/desktop/test/integration/project-reconnect-sync.test.ts effect-audit-baseline.json effect-grep-inventory.json
git commit -m "refactor: make project sync sinks effectful"
```

---

### Task 8: Add named Effect boundaries across contracts and client SDK

**Files:**
- Modify: `packages/contracts/project-sync.ts`
- Modify: `packages/client-ts/spawn.ts`
- Modify: `packages/client-ts/rpc-client.ts`
- Modify: `packages/client-ts/client-session.ts`
- Modify: `packages/client-ts/supervise.ts`
- Modify: `packages/client-ts/with-client.ts`
- Modify: `packages/client-ts/adapters/node.ts`
- Modify: `packages/client-ts/spawn-lock.ts`

**Interfaces:**
- Produces: `Effect.fn` or deliberate `Effect.fnUntraced` for every exported or reusable named Effect-returning function.
- Preserves: direct combinators for short values such as `readEndpoint`, `deleteEndpoint`, and simple Layer composition.
- Preserves: pure functions and anonymous protocol callbacks as ordinary functions.

- [ ] **Step 1: Turn the semantic audit into the failing style gate**

Add fixture coverage in `test/eslint/effect-boundary.test.mjs` proving exported named Effects require `Effect.fn`, pure exports do not, and anonymous callbacks are accepted. Run the focused rule against contracts/client files and record the exact named-effect findings.

- [ ] **Step 2: Verify the red state**

Run:

```bash
npm exec -- eslint --config eslint.effect.config.mjs packages/contracts packages/client-ts --format json
```

Expected: exits 1 with `effectFunctionBoundary` findings for reusable operations including `findOrSpawnBackend`, `acquireClient`, `currentClient`, `makeSession`, `supervised`, `withClient`, and lock operations.

- [ ] **Step 3: Apply named tracing boundaries without wrapping pure logic**

Use stable names such as:

```ts
export const findOrSpawnBackend = Effect.fn("Client.findOrSpawnBackend")(function*(adapter: RuntimeAdapter) {
  const { paths } = yield* AppContext
  return yield* findOrSpawn(adapter, paths)
})

export const supervised = Effect.fn("Client.supervised")(
  <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) =>
    Effect.onExit(effect, (exit) =>
      Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
        ? Effect.logError(`[${label}] background fiber died`, exit.cause)
        : Effect.void
    )
)
```

Use `Effect.gen` for sequential bodies and retain short `map`/`flatMap` expressions. Do not wrap Layer constructors or pure parsers solely to satisfy naming.

- [ ] **Step 4: Verify client/contracts behavior and ratchet**

Run:

```bash
npm exec -- vitest run packages/contracts/test packages/client-ts/test
npm run build --workspace @expand/contracts
npm run build --workspace @expand/client-ts
npm run typecheck:all
npm run effect:audit:update
npm run effect:audit
```

Expected: PASS with no unapproved named-Effect finding in production contracts/client code.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/project-sync.ts packages/client-ts test/eslint/effect-boundary.test.mjs effect-audit-baseline.json effect-grep-inventory.json
git commit -m "refactor: name client Effect operations"
```

---

### Task 9: Add named Effect boundaries across server and close Stage 2

**Files:**
- Modify: `apps/server/application/event-bus.ts`
- Modify: `apps/server/application/projections.ts`
- Modify: `apps/server/application/projects/project-event-store.ts`
- Modify: `apps/server/application/projects/use-cases.ts`
- Modify: `apps/server/application/server/use-cases.ts`
- Modify: `apps/server/composition/app.ts`
- Modify: `apps/server/connection-tracker.ts`
- Modify: `apps/server/db/event-store.ts`
- Modify: `apps/server/db/projection-state-store.ts`
- Modify: `apps/server/db/replay-feed.ts`
- Modify: `apps/server/endpoint-file.ts`
- Modify: `apps/server/rpc/guard.ts`
- Modify: `apps/server/state-root-lock.ts`
- Modify: `effect-grep-inventory.json`
- Modify: `effect-audit-baseline.json`

**Interfaces:**
- Produces: stable named Effect boundaries for reusable server operations.
- Keeps: anonymous RPC handlers and service protocol callbacks anonymous or `Effect.fnUntraced` where tracing each invocation is intentionally avoided.
- Keeps: `timingSafeEqualStrings`, project folds, schema definitions, validation predicates, and row-shape calculations pure.

- [ ] **Step 1: Capture the failing named-effect inventory**

Run:

```bash
npm exec -- eslint --config eslint.effect.config.mjs apps/server --format json
```

Expected: exits 1 with production `effectFunctionBoundary` findings for `runServer`, `secureIfPresent`, `writeEndpointFile`, `guard`, event-store append/decoding, projection checkpoint/apply, use-case mutations, and lock operations.

- [ ] **Step 2: Add stable Effect.fn names**

Convert reusable named effect operations using module-qualified names, for example `Server.run`, `EndpointFile.write`, `RpcGuard.guard`, `EventStore.append`, `Projection.apply`, and `ProjectUseCases.createProject`. Use `Effect.gen` only where values are sequentially bound. Do not turn pure helpers into Effects and do not change RPC contracts.

- [ ] **Step 3: Reconcile the Stage 2 grep inventory**

Run `npm run effect:grep`. Remove fixed migration-debt records. Reclassify only analyzer-proven remaining production matches as exact Node HTTP/entry adapters, host-required types, or lexical false positives. Leave Node child spawning, Electron/UI lifecycles, scripts, benchmarks, examples, and test debt for their later plans.

- [ ] **Step 4: Run the Stage 2 completion matrix**

Run:

```bash
npm run effect:audit:update
npm run effect:audit
npm run effect:grep > /tmp/expand-effect-stage2-grep.txt
npm exec -- vitest run packages/contracts/test packages/client-ts/test apps/cli/test apps/server/test
npm run lint
npm run typecheck:effect-audit
npm run typecheck:all
npm run arch
npm run build
git status --short
```

Expected: every command PASS; remaining measured debt belongs only to Stage 3 host/resource boundaries or Stage 4 development/test surfaces; the tree is otherwise clean.

- [ ] **Step 5: Commit**

```bash
git add apps/server effect-audit-baseline.json effect-grep-inventory.json eslint-rules/effect-host-boundaries.mjs
git commit -m "refactor: name server Effect operations"
```

---

## Plan completion evidence

The controller independently repeats the Task 9 matrix and inspects the two lock protocols for atomicity, typed failure, and interruption cleanup. Stage 3 begins only after AppContext, backend command selection, process probing, identifiers, timestamps, locks, project synchronization, and reusable core operations have no unapproved audit finding.
