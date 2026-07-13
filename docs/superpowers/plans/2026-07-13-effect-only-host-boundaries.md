# Effect-Only Host and Resource Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give child processes, Electron callbacks, MessagePorts, renderer synchronization, React mutations, and Ink startup explicit Effect ownership, cancellation, supervision, and finalization.

**Architecture:** The Node SDK uses Effect's scoped child-process service. Electron IPC binding becomes a scoped interpreter with one supervised callback runner and one exact Promise bridge for invoke. Main and renderer MessagePorts own listeners, queues, fibers, and closure through Scope. Electron main, renderer root, React mutations, and Ink each expose one registered host runner while all application work remains Effect-valued.

**Tech Stack:** TypeScript 6.0.3, Effect 4.0.0-beta.74, `@effect/platform-node` beta 74, Electron 42, React 19, Ink 7, Zustand 5, Vitest 4.1, Playwright 1.60.

## Global Constraints

- Execute after `2026-07-13-effect-only-core-runtime.md` is complete and committed.
- Run `npm run effect:audit:update` only after each task's focused tests pass. It may remove fixed findings but may not add debt.
- Promise-shaped first-party signatures may remain only where Electron or another host declaration requires one. `app.whenReady`, page loading, Ink exit, runtime disposal, and navigation Promises are consumed immediately with `Effect.tryPromise`; wrappers around them return Effect.
- Every listener, port, queue, fiber, BrowserWindow, runtime, and child handle has one owner and an idempotent release path.
- Fire-and-forget callbacks use one supervised runner that observes typed failure and defect. No `.catch(() => {})`, ignored Promise, or unobserved fiber remains.
- Keep preload small and auditable. It may retain exact Electron callback/Promise shapes but does not acquire an application runtime.
- React, DOM, and Ink event callbacks remain synchronous host callbacks. They launch Effects only through one registered owned runner.
- Do not add code comments.
- Every task is implemented by a fresh project `tdd-implementer`, then reviewed by a fresh project `task-reviewer`. Send all Critical and Important findings through one fresh fix wave and repeat the gate before continuing.
- Never dispatch parallel tracked-tree writers.

---

## File responsibility map

- `packages/client-ts/adapters/node.ts`: scoped ChildProcess spawn/unref adapter.
- `packages/electron-ipc/main.ts`: scoped main-process interpreter and supervised callback runner.
- `packages/electron-ipc/renderer.ts`: Crypto-backed nonce and immediate host-Promise adaptation.
- `packages/electron-ipc/preload.ts`: exact bridge construction plus returned subscription teardown.
- `apps/desktop/src/main/rpc/*`: main-side port scope and RPC server protocol.
- `apps/desktop/src/renderer/rpc/*`: renderer-side port scope and RPC client protocol.
- `apps/desktop/src/main/program.ts`: testable scoped Electron lifecycle.
- `apps/desktop/src/renderer/app/runtime.ts`: Deferred-backed boot and synchronization.
- `apps/desktop/src/renderer/features/projects/data/use-projects.ts`: Effect-valued mutation hook with owned fibers.
- `apps/tui/main.tsx`: scoped Ink and ManagedRuntime entry program.
- `apps/tui/use-projects.ts`: owned project-sync and mutation fibers.

---

### Task 1: Replace callback spawning with Effect ChildProcess

**Files:**
- Modify: `packages/client-ts/adapter.ts`
- Modify: `packages/client-ts/adapters/node.ts`
- Modify: `packages/client-ts/client-layer.ts`
- Modify: `packages/client-ts/spawn.ts`
- Modify: `packages/client-ts/test/unit/adapter-spawn-errors.test.ts`
- Modify: `packages/client-ts/test/integration/node-adapter.test.ts`
- Modify: `apps/cli/cli/main.ts`
- Modify: `apps/tui/runtime.ts`
- Modify: `apps/desktop/src/main/runtime.ts`
- Modify: `examples/client-ts/adapter.ts`
- Modify: `bench/scenarios/server-e2e.ts`
- Modify: `packages/client-ts/test/integration/acquire-client.test.ts`
- Modify: `packages/client-ts/test/integration/client-layer.test.ts`
- Modify: `packages/client-ts/test/integration/client-session.test.ts`
- Modify: `packages/client-ts/test/integration/find-or-spawn.test.ts`
- Modify: `packages/client-ts/test/integration/project-sync.test.ts`
- Modify: `packages/client-ts/test/integration/spawn-lock.test.ts`
- Modify: `packages/client-ts/test/unit/entrypoints.test.ts`
- Modify: `apps/desktop/test/integration/connection-honesty.test.ts`
- Modify: `apps/desktop/test/integration/rpc-handlers.test.ts`
- Modify: `apps/desktop/test/integration/rpc-server.test.ts`
- Modify: `apps/desktop/test/integration/transport.test.ts`
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
- Changes: `RuntimeAdapter.spawnBackend(dataDir)` requirement to `ChildProcessSpawner` plus the Stage 2 command requirements.
- Produces: named `NodeAdapter.spawnBackend` using `ChildProcess.make` and a scoped handle.
- Removes: direct `node:child_process`, callback listeners, `process.env`, and the throwing command thunk.

- [ ] **Step 1: Write failing spawner and interruption tests**

Create a fake `ChildProcessSpawner`/handle and assert exact command/args, ignored stdio, inherited environment through the platform option, `unref`, platform error mapping, and interruption before acquisition:

```ts
it.effect("unrefs an accepted backend child", () =>
  adapter.spawnBackend("/state").pipe(
    Effect.provideService(ChildProcessSpawner, fakeSpawner),
    Effect.tap(() => Effect.sync(() => {
      expect(observed.command).toEqual(["node", "server.js", "--data-dir", "/state"])
      expect(observed.options).toMatchObject({ stdin: "ignore", stdout: "ignore", stderr: "ignore", extendEnv: true })
      expect(observed.unrefCount).toBe(1)
    }))
  ))
```

Add a Deferred-controlled acquisition; interrupt it and prove the platform handle is canceled and cannot report late success.

- [ ] **Step 2: Verify the red state**

Run:

```bash
npm exec -- vitest run packages/client-ts/test/unit/adapter-spawn-errors.test.ts packages/client-ts/test/integration/node-adapter.test.ts
```

Expected: new tests FAIL because the adapter manually owns Node listeners and has no interruption finalizer.

- [ ] **Step 3: Implement the scoped command**

Use:

```ts
const spawnBackend = Effect.fn("NodeAdapter.spawnBackend")(function*(dataDir: string) {
  const command = yield* options.backendCommand.pipe(Effect.mapError(toBackendUnavailable))
  const [executable, ...configuredArgs] = command
  if (executable === undefined) {
    return yield* Effect.fail(new BackendUnavailable({ reason: "backend command is empty" }))
  }
  const handle = yield* ChildProcess.make(executable, [...configuredArgs, "--data-dir", dataDir], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    extendEnv: true
  }).pipe(Effect.mapError(toBackendUnavailable))
  yield* handle.unref.pipe(Effect.mapError(toBackendUnavailable))
})
```

Keep the command and handle inside the caller's scope. The Node spawner kills an interrupted pre-spawn child and deliberately leaves a successfully unreferenced child alive when scope closes.

- [ ] **Step 4: Propagate ChildProcessSpawner through layers and verify**

Run:

```bash
npm exec -- vitest run packages/client-ts/test/unit/adapter-spawn-errors.test.ts packages/client-ts/test/integration/node-adapter.test.ts packages/client-ts/test/integration/find-or-spawn.test.ts
npm run build --workspace @expand/client-ts
npm run typecheck:all
npm run effect:audit:update
npm run effect:audit
```

Expected: PASS; `packages/client-ts/adapters/node.ts` has no direct process-spawn or environment access.

- [ ] **Step 5: Commit**

```bash
git add packages/client-ts/adapter.ts packages/client-ts/adapters/node.ts packages/client-ts/client-layer.ts packages/client-ts/spawn.ts packages/client-ts/test apps/cli apps/tui/runtime.ts apps/desktop/src/main examples/client-ts bench effect-audit-baseline.json effect-grep-inventory.json
git commit -m "refactor: spawn backend with Effect"
```

---

### Task 2: Make Electron main IPC binding scoped and supervised

**Files:**
- Modify: `packages/electron-ipc/main.ts`
- Modify: `packages/electron-ipc/main-electron.ts`
- Modify: `packages/electron-ipc/contract.ts`
- Modify: `packages/electron-ipc/test/bind-ipc.test.ts`
- Modify: `packages/electron-ipc/test/contract-types.test.ts`
- Modify: `packages/electron-ipc/test/contract.test.ts`
- Modify: `eslint-rules/effect-host-boundaries.mjs`

**Interfaces:**
- Removes: `BindIpcConfig.runPromise` and manual `BoundIpc.unbind()` ownership.
- Changes: `bindIpc(...)` to a scoped Effect requiring handler environment and returning only the emitter surface.
- Produces: one exact synchronous callback runner using `Effect.runForkWith` and one exact invoke handler returning the Promise Electron requires.
- Produces: failure observation for typed failure, defect, and interruption.

- [ ] **Step 1: Write failing supervision and release tests**

Retain sender validation, size, codec, success/failure envelope, and channel registration tests. Add cases for send/port typed failure, defect, active callback interruption, late completion after release, exactly-once listener/handler removal, and failure logging:

```ts
it.effect("observes a defect from a send callback", () =>
  Effect.scoped(
    Effect.gen(function*() {
      yield* bindIpc(contract, defectingHandlers, config)
      fakeIpc.emit(sendWire, validEvent, payload)
      yield* Deferred.await(observedFailure)
      expect(loggedCause).toContain("die")
    })
  ))
```

- [ ] **Step 2: Verify the red state**

Run:

```bash
npm exec -- vitest run packages/electron-ipc/test/bind-ipc.test.ts packages/electron-ipc/test/contract-types.test.ts packages/electron-ipc/test/contract.test.ts
```

Expected: new cases FAIL because callbacks discard rejections and binding is manually unbound.

- [ ] **Step 3: Build one scoped interpreter runner**

Inside `bindIpc`, obtain the service context, allocate a tracked fiber set, and register every listener removal and fiber interruption with `Effect.addFinalizer`. The registered synchronous host bridge is an ordinary function because its contract returns `void`:

```ts
const context = yield* Effect.context<R>()
const fibers = new Set<Fiber.Fiber<unknown, unknown>>()

const runCallback = <E>(name: string, program: Effect.Effect<void, E, R>): void => {
  const fiber = Effect.runForkWith(context)(
    program.pipe(
      Effect.catchCause((cause) => Effect.logError(`${name}: ${Cause.pretty(cause)}`)),
      Effect.interruptible
    )
  )
  fibers.add(fiber)
  fiber.addObserver(() => fibers.delete(fiber))
}
```

The invoke handler is the only Promise producer and returns `Effect.runPromiseWith(context)(program)` directly. Sender rejection returns an already successful Effect through that same bridge rather than `Promise.resolve`.

Scope finalization removes every registration and interrupts tracked callback fibers. Emit after finalization is a no-op.

- [ ] **Step 4: Register only exact surviving host constructs**

After analyzer verification, add one permanent record for `IpcMainLike.handle`'s required handler Promise type and one for the nested invoke handler's runtime Promise conversion. Remove migration records for send/port Promise chains and general `runPromise` configuration. Do not exempt the complete module.

- [ ] **Step 5: Verify IPC behavior and audit**

Run:

```bash
npm exec -- vitest run packages/electron-ipc/test
npm run typecheck:all
npm run effect:audit:update
npm run effect:audit
```

Expected: PASS; no callback failure is swallowed and scope closure removes or interrupts every resource.

- [ ] **Step 6: Commit**

```bash
git add packages/electron-ipc/main.ts packages/electron-ipc/main-electron.ts packages/electron-ipc/contract.ts packages/electron-ipc/test eslint-rules/effect-host-boundaries.mjs effect-audit-baseline.json effect-grep-inventory.json
git commit -m "refactor: scope Electron IPC binding"
```

---

### Task 3: Own renderer/preload IPC resources and nonce generation

**Files:**
- Modify: `packages/electron-ipc/renderer.ts`
- Modify: `packages/electron-ipc/preload.ts`
- Modify: `packages/electron-ipc/preload-electron.ts`
- Modify: `packages/electron-ipc/test/renderer.test.ts`
- Modify: `packages/electron-ipc/test/preload.test.ts`
- Modify: `packages/electron-ipc/test/validate-sender.test.ts`
- Modify: `eslint-rules/effect-host-boundaries.mjs`

**Interfaces:**
- Changes: nonce creation to an Effect value, defaulting to `Crypto.Crypto.randomUUIDv4`.
- Changes: invoke bridge typing so `Effect.tryPromise` consumes the exact host Promise directly.
- Changes: `exposeBridge` to return one idempotent teardown that releases every static preload subscription.
- Preserves: preload's exact `invoke(...): Promise<unknown>` host signature.

- [ ] **Step 1: Write failing nonce, invoke, and preload teardown tests**

Cover deterministic nonce injection, Crypto failure, synchronous bridge throw, rejected invoke, timeout/interruption with late port delivery, and exactly-once static grant unsubscription. Prove an interrupted port exchange removes the window listener.

- [ ] **Step 2: Verify the red state**

Run:

```bash
npm exec -- vitest run packages/electron-ipc/test/renderer.test.ts packages/electron-ipc/test/preload.test.ts
```

Expected: new tests FAIL because nonce is ambient, invoke uses `Promise.resolve`, and the preload discards a static unsubscribe.

- [ ] **Step 3: Implement Effect nonce and direct Promise adaptation**

Generalize options and client requirements:

```ts
export interface MakeIpcClientOptions<EN = PlatformError.PlatformError, RN = Crypto.Crypto> {
  readonly bridge: () => unknown
  readonly win: RendererWindowLike
  readonly nonce?: Effect.Effect<string, EN, RN>
  readonly timeoutMillis?: number
}
```

For invoke, narrow the bridge member to the exact invoke function and use `Effect.tryPromise({ try: () => invoke(encoded), catch: ... })`; do not create or chain a first-party Promise. For port exchange, yield the nonce before listener installation and preserve callback cancellation/timeout cleanup.

- [ ] **Step 4: Return and consume preload subscription teardown**

Collect every unsubscribe returned by `deps.on` and return one idempotent `dispose(): void` from `exposeBridge`. Update `preload-electron.ts` to own that teardown for the preload lifetime. Keep the module runtime-free and retain only analyzer-proven Promise signatures for Electron invoke/contextBridge.

- [ ] **Step 5: Verify IPC clients and audit**

Run:

```bash
npm exec -- vitest run packages/electron-ipc/test
npm run typecheck:all
npm run effect:audit:update
npm run effect:audit
```

Expected: PASS; ambient `crypto.randomUUID`, `Promise.resolve`, and leaked preload subscriptions are gone.

- [ ] **Step 6: Commit**

```bash
git add packages/electron-ipc/renderer.ts packages/electron-ipc/preload.ts packages/electron-ipc/preload-electron.ts packages/electron-ipc/test eslint-rules/effect-host-boundaries.mjs effect-audit-baseline.json effect-grep-inventory.json
git commit -m "refactor: own renderer IPC resources"
```

---

### Task 4: Scope desktop MessagePorts and RPC protocols

**Files:**
- Modify: `apps/desktop/src/main/rpc/transport.ts`
- Modify: `apps/desktop/src/main/rpc/server.ts`
- Modify: `apps/desktop/src/main/ipc/port-lifecycle.ts`
- Modify: `apps/desktop/src/main/security/harden-web-contents.ts`
- Modify: `apps/desktop/src/renderer/rpc/renderer-port.ts`
- Modify: `apps/desktop/src/renderer/rpc/transport.ts`
- Modify: `apps/desktop/test/integration/transport.test.ts`
- Modify: `apps/desktop/test/integration/rpc-server.test.ts`
- Modify: `apps/desktop/test/integration/connection-honesty.test.ts`
- Modify: `apps/desktop/test/unit/renderer-boot-port.test.ts`
- Modify: `apps/desktop/test/unit/port-lifecycle.test.ts`
- Modify: `apps/desktop/test/unit/harden-web-contents.test.ts`

**Interfaces:**
- Changes: `MainPortLike` to include `off`, `close`, and close/message listeners.
- Changes: `RendererPortLike` to include `close` and explicit handler cleanup.
- Changes: `connectPort` from `() => Promise<void>` teardown to an Effect requiring Scope.
- Changes: navigation/window/hardening registration functions to return Effect finalizers or unsubscribe functions.

- [ ] **Step 1: Write failing resource-ownership tests**

Cover normal RPC, remote close, local interruption, no delivery after scope closure, idempotent finalization, queue shutdown, port closure, listener removal, supersession ordering, navigation, window close, and application shutdown. In the supersession case, hold the old finalizer behind a Deferred and prove the new grant waits.

- [ ] **Step 2: Verify the red state**

Run:

```bash
npm exec -- vitest run apps/desktop/test/integration/transport.test.ts apps/desktop/test/integration/rpc-server.test.ts apps/desktop/test/integration/connection-honesty.test.ts apps/desktop/test/unit/renderer-boot-port.test.ts
```

Expected: new cases FAIL because listeners/queues/ports outlive their scopes and teardown returns a Promise.

- [ ] **Step 3: Make both port protocols scoped**

Use `Effect.acquireRelease`/`Effect.addFinalizer` around listener installation, queue creation, inbound fibers, and ports. On close, offer a disconnect signal and shut down queues. Main protocol `disconnects` reflects remote/local close. Renderer finalization sets `onmessage = null`, shuts its queue, and closes the port.

Change:

```ts
export const connectPort = Effect.fn("DesktopMain.connectPort")(function*(deps: ConnectPortDeps) {
  const context = yield* deps.runtime.contextEffect
  yield* Effect.forkScoped(
    supervised("desktop-main rpc bridge", runRpcServer(deps.port)).pipe(
      Effect.provide(context)
    )
  )
  return yield* Effect.never
})
```

The port fiber belongs to the caller's Scope and is interrupted by scope finalization. `ManagedRuntime.contextEffect` exposes the already-built service context without adding a runner inside an Effect body, and no Promise-returning teardown or extra host exemption remains.

- [ ] **Step 4: Serialize lifecycle and hardening subscriptions**

Make all registration dependency methods return unsubscribe functions. Port supersession closes the prior child Scope and awaits completion before installing/granting the next bridge. Navigation, close, CSP, and will-navigate registrations belong to the window scope and release exactly once.

- [ ] **Step 5: Verify desktop transport ownership**

Run:

```bash
npm exec -- vitest run apps/desktop/test/integration/transport.test.ts apps/desktop/test/integration/rpc-server.test.ts apps/desktop/test/integration/connection-honesty.test.ts apps/desktop/test/unit/renderer-boot-port.test.ts
npm run typecheck:desktop
npm run effect:audit:update
npm run effect:audit
```

Expected: PASS with no Promise teardown, late delivery, open queue, listener, or unclosed port.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/rpc apps/desktop/src/main/ipc/port-lifecycle.ts apps/desktop/src/main/security/harden-web-contents.ts apps/desktop/src/renderer/rpc apps/desktop/test effect-audit-baseline.json effect-grep-inventory.json
git commit -m "refactor: scope desktop RPC ports"
```

---

### Task 5: Move Electron main startup and shutdown into one scoped program

**Files:**
- Create: `apps/desktop/src/main/program.ts`
- Create: `apps/desktop/test/unit/main-program.test.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/main/runtime.ts`
- Modify: `apps/desktop/src/main/ipc/port-lifecycle.ts`
- Modify: `apps/desktop/src/main/security/harden-web-contents.ts`
- Modify: `apps/desktop/test/integration/connection-honesty.test.ts`
- Modify: `apps/desktop/test/integration/project-reconnect-sync.test.ts`
- Modify: `apps/desktop/test/integration/rpc-handlers.test.ts`
- Modify: `apps/desktop/test/integration/rpc-server.test.ts`
- Modify: `apps/desktop/test/integration/transport.test.ts`
- Modify: `eslint-rules/effect-host-boundaries.mjs`

**Interfaces:**
- Produces: testable `DesktopMainHost` structural adapter and tagged `DesktopMainError`.
- Produces: named scoped `mainProgram(host)` owning readiness, runtime, window, page load, IPC, MessagePorts, listeners, and shutdown.
- Leaves: one `NodeRuntime.runMain` entrypoint in `apps/desktop/src/main/index.ts`.

- [ ] **Step 1: Write failing lifecycle tests against a structural host**

Cover readiness rejection, page-load rejection, normal quit, `before-quit` waiting for finalizers, exactly-once release, runtime disposal failure observation, and platform-specific `window-all-closed`. Record lifecycle order and assert port/IPC/window resources close before final quit.

- [ ] **Step 2: Verify the red state**

Run:

```bash
npm exec -- vitest run apps/desktop/test/unit/main-program.test.ts
```

Expected: FAIL because lifecycle logic is embedded in top-level Promise chains and permanent listeners.

- [ ] **Step 3: Implement a scoped main program**

Define host-required Promise signatures narrowly:

```ts
export interface DesktopMainHost {
  readonly whenReady: () => Promise<void>
  readonly loadWindow: (window: BrowserWindowLike) => Promise<void>
  readonly createWindow: () => BrowserWindowLike
  readonly onBeforeQuit: (listener: BeforeQuitListener) => () => void
  readonly onWindowAllClosed: (listener: () => void) => () => void
  readonly quit: () => void
  readonly platform: "darwin" | "linux" | "win32"
}
```

`mainProgram` immediately wraps `whenReady` and `loadWindow` with `Effect.tryPromise`. Acquire the ManagedRuntime, BrowserWindow, IPC binding, lifecycle subscriptions, and current port child Scope with `acquireRelease`. `before-quit` prevents the first quit, starts one supervised finalization Effect, and calls final `quit` only after scope closure. Repeated quit events are idempotent.

- [ ] **Step 4: Reduce index.ts to one registered entry boundary**

`index.ts` constructs the real Electron adapter and calls `NodeRuntime.runMain(mainProgram(host).pipe(Effect.provide(NodeServices.layer)))`. Replace direct environment/platform/console reads with Config, explicit host adapter fields, and Effect logging. Register the one runner and the exact host Promise signatures; remove all migration-era `.then`, ignored load, and dispose records.

- [ ] **Step 5: Verify main lifecycle and desktop build**

Run:

```bash
npm exec -- vitest run apps/desktop/test/unit/main-program.test.ts apps/desktop/test/integration
npm run typecheck:desktop
npm run build:desktop
npm run effect:audit:update
npm run effect:audit
```

Expected: PASS; Electron main has one runner and every host Promise is consumed immediately.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main apps/desktop/test/unit/main-program.test.ts apps/desktop/test/integration eslint-rules/effect-host-boundaries.mjs effect-audit-baseline.json effect-grep-inventory.json
git commit -m "refactor: scope Electron main lifecycle"
```

---

### Task 6: Replace renderer boot Promise with Deferred and own the root fiber

**Files:**
- Modify: `apps/desktop/src/renderer/app/runtime.ts`
- Create: `apps/desktop/src/renderer/app/runner.ts`
- Modify: `apps/desktop/src/renderer/main.tsx`
- Modify: `apps/desktop/test/unit/renderer-boot-port.test.ts`
- Modify: `apps/desktop/test/unit/renderer-sync-supervision.test.ts`
- Modify: `eslint-rules/effect-host-boundaries.mjs`

**Interfaces:**
- Replaces: native `firstSnapshot` Promise with `Deferred<void>`.
- Produces: one `RendererRunner` host bridge that owns fibers and maps non-interruption failure to a renderer callback.
- Produces: unload/HMR cleanup that interrupts the root fiber and unmounts React.

- [ ] **Step 1: Write failing Deferred and root cleanup tests**

Cover first snapshot success, sink failure before first snapshot, timeout, interruption, one mount, root failure rendering, unload, and HMR/root cleanup. Prove no state update occurs after root interruption.

- [ ] **Step 2: Verify the red state**

Run:

```bash
npm exec -- vitest run apps/desktop/test/unit/renderer-boot-port.test.ts apps/desktop/test/unit/renderer-sync-supervision.test.ts
```

Expected: new tests FAIL because boot constructs a Promise and root fiber has no release owner.

- [ ] **Step 3: Implement Deferred boot and one runner**

Inside boot:

```ts
const firstSnapshot = yield* Deferred.make<void>()
const syncFiber = yield* Effect.forkScoped(
  runProjectSync(source, {
    status: sink.status,
    snapshot: (snapshot) => sink.snapshot(snapshot).pipe(
      Effect.andThen(Deferred.succeed(firstSnapshot, undefined)),
      Effect.asVoid
    )
  })
)
yield* Effect.raceFirst(Deferred.await(firstSnapshot), Fiber.join(syncFiber))
```

Create a single runner module containing the exact `Effect.runFork` boundary. It tracks/removes observers, reports non-interruption causes, and exposes an idempotent interrupt Effect/callback for unload and HMR. `main.tsx` uses the runner and no direct Effect runner.

- [ ] **Step 4: Verify renderer boot and audit**

Run:

```bash
npm exec -- vitest run apps/desktop/test/unit/renderer-boot-port.test.ts apps/desktop/test/unit/renderer-sync-supervision.test.ts
npm run typecheck:desktop
npm run effect:audit:update
npm run effect:audit
```

Expected: PASS; no native boot Promise or unowned renderer root fiber remains.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/app/runtime.ts apps/desktop/src/renderer/app/runner.ts apps/desktop/src/renderer/main.tsx apps/desktop/test/unit/renderer-boot-port.test.ts apps/desktop/test/unit/renderer-sync-supervision.test.ts eslint-rules/effect-host-boundaries.mjs effect-audit-baseline.json effect-grep-inventory.json
git commit -m "refactor: own desktop renderer boot"
```

---

### Task 7: Replace React mutation Promises with owned Effects

**Files:**
- Modify: `apps/desktop/src/renderer/features/projects/data/project-context.tsx`
- Modify: `apps/desktop/src/renderer/features/projects/data/use-projects.ts`
- Modify: `apps/desktop/src/renderer/features/command/components/CommandPalette.tsx`
- Modify: `apps/desktop/src/renderer/features/projects/components/EditMetadataDialog.tsx`
- Modify: `apps/desktop/src/renderer/features/projects/pages/ProjectsView.tsx`
- Modify: `apps/desktop/test/unit/use-mutation-state.test.tsx`
- Modify: `apps/desktop/test/unit/project-context.test.tsx`
- Modify: `apps/desktop/test/ui/command-palette-restore.test.tsx`
- Modify: `apps/desktop/test/ui/edit-metadata-dialog.test.tsx`
- Modify: `apps/desktop/test/ui/projects-view-hides-archived.test.tsx`

**Interfaces:**
- Removes: `MutationState.mutateAsync` and every Promise-returning first-party mutation function.
- Changes: `useRunMutation` input from `(input) => Promise<A>` to `(input) => Effect<A, E>`.
- Produces: callback-only `mutate(input, options)` backed by the boot-owned `RendererRunner`.
- Guarantees: active mutation interruption on unmount and no state update after unmount.

- [ ] **Step 1: Write failing hook lifecycle tests**

Assert success/error callbacks, pending/reset state, interruption on unmount, latest-function ref behavior, no update after unmount, and navigation rejection observation. Update component tests to use callback completion rather than awaiting component handlers.

- [ ] **Step 2: Verify the red state**

Run:

```bash
npm exec -- vitest run apps/desktop/test/unit/use-mutation-state.test.tsx apps/desktop/test/unit/project-context.test.tsx apps/desktop/test/ui/command-palette-restore.test.tsx apps/desktop/test/ui/edit-metadata-dialog.test.tsx
```

Expected: FAIL because hooks expose Promise APIs and call `Effect.runPromise` per mutation.

- [ ] **Step 3: Implement the Effect-valued mutation API**

Use:

```ts
export interface MutationState<I, A, E> {
  readonly mutate: (input: I, options?: MutationOptions<A, E>) => void
  readonly error: E | undefined
  readonly isPending: boolean
  readonly reset: () => void
}

export const useRunMutation = <I, A, E>(
  run: (input: I) => Effect.Effect<A, E>
): MutationState<I, A, E> => {
  const runner = useRendererRunner()
  return useOwnedMutation(runner, run)
}
```

The runner starts one Effect fiber, observes `Exit`, updates state through synchronous React callbacks only while mounted, and interrupts all active fibers during cleanup. RPC hooks return their Effects directly. Navigation host Promises are wrapped at the runner boundary with `Effect.tryPromise`.

- [ ] **Step 4: Remove async component handlers and verify**

Convert palette/dialog flows to `mutate(..., { onSuccess, onError })`. Run:

```bash
npm exec -- vitest run apps/desktop/test/unit/use-mutation-state.test.tsx apps/desktop/test/unit/project-context.test.tsx apps/desktop/test/ui
npm run typecheck:desktop
npm run effect:audit:update
npm run effect:audit
```

Expected: PASS; renderer application hooks/components expose no Promise or async handler.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/features apps/desktop/src/renderer/app/runner.ts apps/desktop/test/unit apps/desktop/test/ui effect-audit-baseline.json effect-grep-inventory.json
git commit -m "refactor: run desktop mutations as Effects"
```

---

### Task 8: Move TUI synchronization, mutations, and Ink lifecycle into Effect

**Files:**
- Modify: `apps/tui/main.tsx`
- Modify: `apps/tui/runtime.ts`
- Create: `apps/tui/effect-runner.ts`
- Modify: `apps/tui/use-projects.ts`
- Modify: `apps/tui/test/ui/_runtime-harness.ts`
- Modify: `apps/tui/test/ui/use-projects.test.tsx`
- Modify: `apps/tui/test/ui/app-mutation-error.test.tsx`
- Modify: `apps/tui/test/ui/app-archive.test.tsx`
- Modify: `apps/tui/test/ui/app-delete.test.tsx`
- Modify: `apps/tui/test/ui/app-input-routing.test.tsx`
- Modify: `apps/tui/test/ui/confirm-delete.test.tsx`
- Modify: `apps/tui/test/ui/project-list.test.tsx`
- Modify: `apps/tui/test/ui/text-field.test.tsx`
- Modify: `eslint-rules/effect-host-boundaries.mjs`

**Interfaces:**
- Produces: one registered Ink/React runner for ManagedRuntime fibers.
- Produces: scoped `tuiProgram` that owns the ManagedRuntime, Ink render instance, project-sync fiber, and exit wait.
- Removes: async mutation wrapper, unsafe interruption, `.then(runtime.dispose)`, and discarded mutation Promises.

- [ ] **Step 1: Write failing runner, mutation, and startup tests**

Cover project-sync failure, mutation success/failure, overlapping mutation ownership, unmount interruption, no late update, Ink exit, render failure, runtime disposal, and exactly-once teardown. Use a Deferred-controlled fake runtime for ordering.

- [ ] **Step 2: Verify the red state**

Run:

```bash
npm exec -- vitest run apps/tui/test/ui/use-projects.test.tsx apps/tui/test/ui/app-mutation-error.test.tsx
```

Expected: new tests FAIL because mutations use async/await and startup chains host Promises.

- [ ] **Step 3: Implement one TUI framework runner**

`effect-runner.ts` is the only React/Ink bridge allowed to call `runtime.runFork`. It observes failures, interrupts on cleanup through the same runtime, and guards state callbacks after unmount. `useProjects` passes Effect-valued sink callbacks and mutation programs directly to it; pure `describeError` remains pure.

- [ ] **Step 4: Build the scoped Ink entry program**

Acquire the production ManagedRuntime and Ink render result with `Effect.acquireRelease`. Wrap only Ink's host-required `waitUntilExit()` Promise with `Effect.tryPromise`; finalize the runtime with `runtime.disposeEffect`, unmount Ink, and dispose exactly once. Run only `tuiProgram` through `NodeRuntime.runMain` with NodeServices at module entry.

- [ ] **Step 5: Verify TUI behavior and Stage 3 closure**

Run:

```bash
npm exec -- vitest run apps/tui/test packages/electron-ipc/test apps/desktop/test packages/client-ts/test/integration/node-adapter.test.ts
npm run effect:audit:update
npm run effect:audit
npm run effect:grep > /tmp/expand-effect-stage3-grep.txt
npm run lint
npm run typecheck:effect-audit
npm run typecheck:all
npm run arch
npm run build:desktop
git status --short
```

Expected: every command PASS; remaining migration debt is confined to scripts, examples, benchmarks, tests, fixtures, Playwright, and the binary-smoke shell harness.

- [ ] **Step 6: Commit**

```bash
git add apps/tui eslint-rules/effect-host-boundaries.mjs effect-audit-baseline.json effect-grep-inventory.json
git commit -m "refactor: run TUI lifecycle with Effect"
```

---

## Plan completion evidence

The controller independently repeats the Task 8 matrix and inspects interruption and late-delivery tests for child spawn, IPC callbacks, ports, Electron quit, renderer unload, React unmount, and Ink exit. Stage 4 begins only when every production host resource has a registered owner and every surviving host Promise/runner record resolves to one exact declaration and occurrence.
