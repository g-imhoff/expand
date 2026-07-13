# Client Session and Project Synchronization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Remove the shared ProjectStore, move reconnecting transport ownership into ClientSession, share race-free synchronization through runProjectSync, and give desktop and TUI native client-owned state.

**Architecture:** ClientSession owns backend acquisition, reconnect, connection epochs, and status without holding project data. ProjectClient and ServerClient delegate through the current epoch, while the renderer-safe @expand/contracts/project-sync module converts list plus replayable events into atomic snapshots for an injected sink. Desktop writes those snapshots into a boot-scoped vanilla Zustand store, TUI writes them into React-local state, and CLI stays stateless.

**Tech Stack:** TypeScript 6, Effect 4.0.0-beta.74, Effect RPC, React 19, Ink 7, Zustand 5, Electron 42, Vitest 4, Bun 1.3.

## Global Constraints

- Delete ProjectStore, ProjectStoreLayer, ProjectStoreApi, subscribeRef, and packages/client-ts/project/store.ts with no compatibility alias.
- ClientSession is connection-level and must never contain a project collection.
- runProjectSync is framework-neutral and must expose no SubscriptionRef, React, Ink, or Zustand API.
- Electron renderer and preload code must not import @expand/client-ts; shared synchronization comes from @expand/contracts/project-sync.
- Project state remains event-authoritative; mutation responses must not update client-owned snapshots optimistically.
- A reconnect retains the last snapshot and replaces it atomically from a fresh list before replay continues.
- Events with a sequence less than or equal to the current cursor are ignored.
- Desktop creates one zustand/vanilla store per renderer boot and never uses a module-global project store.
- TUI uses React-local state and must not depend on Zustand.
- CLI uses ProjectClient and ServerClient only and must not instantiate project synchronization.
- Do not add code comments.
- Every task is implemented by a fresh tdd-implementer and followed by a fresh task-reviewer; all Critical and Important findings are fixed and reviewed again before the next task.

---

## File responsibility map

- packages/client-ts/client-session.ts: reconnecting connection lifecycle, status, current epoch, and epoch stream.
- packages/client-ts/rpc-client.ts: one-epoch RPC acquisition primitive only.
- packages/client-ts/project/client.ts: typed project request/response calls and one-epoch Events delegation.
- packages/client-ts/server/client.ts: typed health call through the current epoch.
- packages/client-ts/client-layer.ts: one shared ClientSession composed with both domain clients.
- packages/contracts/project-sync.ts: renderer-safe list, replay, sequence gate, atomic snapshot publication, and reconnect resynchronization.
- apps/desktop/src/main/rpc/*.ts: transparent renderer-to-upstream request and stream forwarding.
- apps/desktop/src/renderer/features/projects/data/project-store.ts: boot-scoped vanilla Zustand state only.
- apps/desktop/src/renderer/features/projects/data/project-context.tsx: React context and Zustand selector access.
- apps/desktop/src/renderer/features/projects/data/use-projects.ts: query and mutation hooks over the desktop context.
- apps/tui/use-projects.ts: TUI-local React snapshot and mutation error state.

---

### Task 1: Extract the reconnecting ClientSession

**Files:**
- Create: packages/client-ts/client-session.ts
- Create: packages/client-ts/test/integration/client-session.test.ts
- Modify: packages/client-ts/rpc-client.ts
- Modify: packages/client-ts/index.ts

**Interfaces:**
- Consumes: acquireClient(adapter): Effect<{ client, endpoint }, BackendUnavailable, FileSystem | Scope>.
- Produces:

        export type ConnectionStatus = "connected" | "reconnecting" | "disconnected"

        export interface ClientSessionApi {
          readonly status: SubscriptionRef.SubscriptionRef<ConnectionStatus>
          readonly current: Effect.Effect<ExpandRpcClientApi>
          readonly epochs: Stream.Stream<ExpandRpcClientApi>
        }

        export class ClientSession extends Context.Service<ClientSession, ClientSessionApi>()(
          "expand/ClientSession"
        ) {}

        export const ClientSessionLayer: (
          adapter: RuntimeAdapter
        ) => Layer.Layer<ClientSession, BackendUnavailable, FileSystem.FileSystem>

- Contract: current emits the active epoch immediately or waits while the session reconnects; epochs emits every non-null acquired client once.

- [ ] **Step 1: Write the failing ClientSession lifecycle tests**

Add a scripted adapter/backend fixture to client-session.test.ts using the real RPC protocol pattern already used by reconnect.test.ts. Cover these exact cases:

        describe("ClientSession", () => {
          it("fails the layer with BackendUnavailable when first acquisition fails", async () => {
            const result = await Effect.runPromise(
              Effect.scoped(Layer.build(ClientSessionLayer(failingAdapter))).pipe(Effect.result)
            )
            expect(Result.isFailure(result)).toBe(true)
          })

          it("publishes connected, reconnecting, connected across reacquisition", async () => {
            const observed = await runReconnectScenario((session) =>
              SubscriptionRef.changes(session.status).pipe(
                Stream.takeUntil((status) => status === "connected" && reconnectCount() === 1),
                Stream.runCollect
              )
            )
            expect(Array.from(observed)).toEqual(["connected", "reconnecting", "connected"])
          })

          it("invalidates the stale epoch before publishing reconnecting", async () => {
            const result = await runDisconnectOrderingScenario()
            expect(result.currentResolvedWhileReconnecting).toBe(false)
          })

          it("current waits for and returns the next epoch", async () => {
            const result = await runCurrentWaitScenario()
            expect(result.second).not.toBe(result.first)
            expect(result.health).toBe("ok")
          })

          it("scope closure publishes disconnected and interrupts retry", async () => {
            const result = await runScopeClosureScenario()
            expect(result.status).toBe("disconnected")
            expect(result.retryFiberInterrupted).toBe(true)
          })
        })

- [ ] **Step 2: Run the new test and verify the red state**

Run:

    bun --bun vitest run packages/client-ts/test/integration/client-session.test.ts

Expected: FAIL because packages/client-ts/client-session.ts and its exports do not exist.

- [ ] **Step 3: Implement ClientSession**

Move the reconnect schedule, initial-ready barrier, error normalization, and RpcClient.ConnectionHooks wiring out of project/store.ts. The core construction must have this shape:

        const currentClient = <A>(
          ref: SubscriptionRef.SubscriptionRef<A | null>
        ): Effect.Effect<A> =>
          SubscriptionRef.changes(ref).pipe(
            Stream.filter((value): value is A => value !== null),
            Stream.runHead,
            Effect.map(Option.getOrThrow)
          )

        const makeSession = (
          adapter: RuntimeAdapter
        ): Effect.Effect<ClientSessionApi, BackendUnavailable, FileSystem.FileSystem | Scope.Scope> =>
          Effect.gen(function* () {
            const status = yield* SubscriptionRef.make<ConnectionStatus>("disconnected")
            const clients = yield* SubscriptionRef.make<ExpandRpcClientApi | null>(null)
            const ready = yield* Deferred.make<void, BackendUnavailable>()

            const acquireEpoch = Effect.scoped(
              Effect.gen(function* () {
                const disconnected = yield* Deferred.make<void>()
                const hooked = withConnectionHooks(adapter, clients, status, disconnected)
                const { client } = yield* acquireClient(hooked)
                yield* SubscriptionRef.set(clients, client)
                yield* SubscriptionRef.set(status, "connected")
                yield* Deferred.succeed(ready, undefined)
                yield* Deferred.await(disconnected)
                return yield* Effect.fail(new BackendUnavailable({ reason: "connection lost" }))
              })
            )

            const loop = acquireEpoch.pipe(
              Effect.tapError((error) => Deferred.fail(ready, toUnavailable(error))),
              Effect.exit,
              Effect.flatMap((exit) =>
                Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
                  ? Effect.failCause(exit.cause)
                  : Effect.fail(new BackendUnavailable({ reason: "connection lost" }))
              ),
              Effect.retry(reconnectPolicy)
            )

            yield* Effect.addFinalizer(() =>
              SubscriptionRef.set(clients, null).pipe(
                Effect.andThen(SubscriptionRef.set(status, "disconnected"))
              )
            )
            yield* Effect.forkScoped(supervised("client-session-connection", loop))
            yield* Deferred.await(ready)

            return {
              status,
              current: currentClient(clients),
              epochs: SubscriptionRef.changes(clients).pipe(
                Stream.filter((client): client is ExpandRpcClientApi => client !== null)
              )
            }
          })

The onDisconnect hook must set clients to null before setting status to reconnecting, then complete the epoch's disconnected Deferred.

- [ ] **Step 4: Export and typecheck the session surface**

Update packages/client-ts/index.ts to export ClientSession, ClientSessionLayer, ClientSessionApi, and ConnectionStatus from client-session.ts. Remove the old ConnectionStatus re-export from project/store.ts only after the new export is present.

Run:

    bun run typecheck

Expected: PASS with ProjectStore still compiling against its existing local connection loop.

- [ ] **Step 5: Run focused and regression tests**

Run:

    bun --bun vitest run packages/client-ts/test/integration/client-session.test.ts packages/client-ts/test/integration/acquire-client.test.ts

Expected: PASS.

- [ ] **Step 6: Commit**

    git add packages/client-ts/client-session.ts packages/client-ts/rpc-client.ts packages/client-ts/index.ts packages/client-ts/test/integration/client-session.test.ts
    git commit -m "feat: add reconnecting client session"

---

### Task 2: Rebase domain clients and CLI composition on ClientSession

**Files:**
- Modify: packages/client-ts/project/client.ts
- Modify: packages/client-ts/server/client.ts
- Modify: packages/client-ts/client-layer.ts
- Modify: packages/client-ts/with-client.ts
- Modify: packages/client-ts/test/expand-client.test.ts
- Create: packages/client-ts/test/integration/client-layer.test.ts
- Modify: packages/client-ts/test/integration/bun-adapter-spawn.test.ts
- Modify: packages/client-ts/test/integration/node-adapter.test.ts
- Verify: apps/cli/cli/main.ts
- Verify: apps/cli/test

**Interfaces:**
- Consumes: ClientSessionApi.current, ClientSessionLayer(adapter).
- Produces:

        readonly events: (
          payload?: { readonly fromSeq?: number }
        ) => Stream.Stream<SequencedEvent, RpcClientError.RpcClientError>

  on ProjectClientApi.
- Produces: ClientLayer(adapter) with one shared ClientSession | ProjectClient | ServerClient environment.

- [ ] **Step 1: Write failing client composition tests**

Add these assertions:

        it("ProjectClient events delegates the requested fromSeq", async () => {
          const requested = await runProjectEvents({ fromSeq: 41 })
          expect(requested).toEqual({ fromSeq: 41 })
        })

        it("ProjectClient events remains bound to one connection epoch", async () => {
          const result = await runBoundEpochScenario()
          expect(result.firstStreamEpochs).toEqual([1])
          expect(result.secondStreamEpochs).toEqual([2])
        })

        it("a command started during reconnect uses the reacquired epoch", async () => {
          const result = await runCommandDuringReconnect()
          expect(result.epoch).toBe(2)
        })

        it("ClientLayer shares one ClientSession", async () => {
          const result = await runSharedLayerScenario()
          expect(result.acquisitions).toBe(1)
          expect(result.projectHealthEpoch).toBe(result.serverHealthEpoch)
        })

Update the Bun and Node adapter tests to create through ProjectClient and verify with client.list({ includeArchived: true }).

- [ ] **Step 2: Run the client tests and verify they fail**

Run:

    bun --bun vitest run packages/client-ts/test/expand-client.test.ts packages/client-ts/test/integration/client-layer.test.ts packages/client-ts/test/integration/bun-adapter-spawn.test.ts packages/client-ts/test/integration/node-adapter.test.ts

Expected: FAIL because ProjectClient has no events method and the live clients still depend on ExpandRpcClient.

- [ ] **Step 3: Rebase ProjectClient and ServerClient**

ProjectClientLive must depend on ClientSession and delegate every operation through session.current:

        export const ProjectClientLive: Layer.Layer<ProjectClient, never, ClientSession> =
          Layer.effect(
            ProjectClient,
            Effect.map(ClientSession, (session): ProjectClientApi => ({
              create: (payload) =>
                Effect.flatMap(session.current, (client) => client.ProjectCreate(payload)),
              rename: (payload) =>
                Effect.flatMap(session.current, (client) => client.ProjectRename(payload)),
              changeDirectory: (payload) =>
                Effect.flatMap(session.current, (client) => client.ProjectChangeDirectory(payload)),
              archive: (payload) =>
                Effect.flatMap(session.current, (client) => client.ProjectArchive(payload)),
              restore: (payload) =>
                Effect.flatMap(session.current, (client) => client.ProjectRestore(payload)),
              setMetadata: (payload) =>
                Effect.flatMap(session.current, (client) => client.ProjectSetMetadata(payload)),
              delete: (payload) =>
                Effect.flatMap(session.current, (client) => client.ProjectDelete(payload)),
              list: (payload = {}) =>
                Effect.flatMap(session.current, (client) => client.ProjectList(payload)),
              events: (payload = {}) =>
                Stream.unwrap(
                  Effect.map(session.current, (client) => client.Events(payload))
                )
            }))
          )

ServerClientLive must flatMap session.current before Health. ProjectClientLayer and ServerClientLayer each provide ClientSessionLayer(adapter).

- [ ] **Step 4: Compose one shared session**

Implement ClientLayer with provideMerge so the session stays in the output environment:

        export const ClientLayer = (
          adapter: RuntimeAdapter
        ): Layer.Layer<
          ClientSession | ProjectClient | ServerClient,
          BackendUnavailable,
          FileSystem.FileSystem
        > =>
          Layer.mergeAll(ProjectClientLive, ServerClientLive).pipe(
            Layer.provideMerge(ClientSessionLayer(adapter))
          )

Rebase withClient on ClientSessionLayer and session.current. Remove ExpandRpcClient and ExpandRpcClientLayer only when no caller remains; retain acquireClient and ExpandRpcClientApi as the one-epoch primitive and public plumbing type.

- [ ] **Step 5: Certify the CLI remains stateless**

Run:

    bun --bun vitest run apps/cli/test
    bun run typecheck

Expected: PASS. apps/cli/cli/main.ts continues to provide ClientLayer and uses only ProjectClient and ServerClient; it must not import ClientSession or runProjectSync.

- [ ] **Step 6: Run focused client tests**

Run:

    bun --bun vitest run packages/client-ts/test/expand-client.test.ts packages/client-ts/test/integration/client-layer.test.ts packages/client-ts/test/integration/bun-adapter-spawn.test.ts packages/client-ts/test/integration/node-adapter.test.ts

Expected: PASS.

- [ ] **Step 7: Commit**

    git add packages/client-ts/project/client.ts packages/client-ts/server/client.ts packages/client-ts/client-layer.ts packages/client-ts/with-client.ts packages/client-ts/test apps/cli
    git commit -m "refactor: use client session in domain clients"

---

### Task 3: Add renderer-safe framework-neutral ProjectSync

**Files:**
- Create: packages/contracts/project-sync.ts
- Create: packages/contracts/test/project-sync.test.ts
- Create: packages/client-ts/test/integration/project-sync.test.ts

**Interfaces:**
- Consumes: Project.foldList, ProjectClientApi.list, and ProjectClientApi.events. ProjectSyncStatus is defined in contracts and is structurally compatible with ClientSession.ConnectionStatus without importing client-ts.
- Produces:

        export interface ProjectSnapshot {
          readonly projects: ReadonlyArray<Project>
          readonly seq: number
        }

        export type ProjectSyncStatus =
          | "connected"
          | "reconnecting"
          | "disconnected"

        export interface ProjectSyncSource<E = never, R = never> {
          readonly status: Stream.Stream<ProjectSyncStatus, E, R>
          readonly list: () => Effect.Effect<ProjectSnapshot, E, R>
          readonly events: (
            payload: { readonly fromSeq: number }
          ) => Stream.Stream<SequencedEvent, E, R>
        }

        export interface ProjectSyncSink {
          readonly snapshot: (snapshot: ProjectSnapshot) => void
          readonly status: (status: ProjectSyncStatus) => void
        }

        export const runProjectSync: <E, R>(
          source: ProjectSyncSource<E, R>,
          sink: ProjectSyncSink
        ) => Effect.Effect<never, never, R>

- [ ] **Step 1: Write the failing ProjectSync unit tests**

Use controllable PubSub status and event streams plus a sink that records complete snapshots. Cover:

        it("publishes the initial snapshot atomically", async () => {
          const result = await runInitialSyncScenario()
          expect(result.snapshots).toEqual([{ projects: [alpha], seq: 4 }])
          expect(result.eventRequests).toEqual([{ fromSeq: 4 }])
        })

        it("ignores duplicate and stale event sequences", async () => {
          const result = await runSequenceGateScenario([5, 5, 3, 6])
          expect(result.snapshots.map((snapshot) => snapshot.seq)).toEqual([4, 5, 6])
        })

        it("replays a mutation between list and event subscription", async () => {
          const result = await runBootstrapReplayScenario()
          expect(result.snapshot.projects.map((project) => project.name)).toEqual(["alpha-2"])
          expect(result.snapshot.seq).toBe(2)
        })

        it("retains state while reconnecting and replaces it after resnapshot", async () => {
          const result = await runResnapshotScenario()
          expect(result.atReconnect).toEqual({ projects: [alpha], seq: 1 })
          expect(result.afterReconnect).toEqual({ projects: [beta], seq: 5 })
        })

        it("interruption stops delivery", async () => {
          const result = await runInterruptionScenario()
          expect(result.afterInterrupt).toEqual(result.beforeInterrupt)
        })

- [ ] **Step 2: Run the unit tests and verify they fail**

Run:

    bun --bun vitest run packages/contracts/test/project-sync.test.ts

Expected: FAIL because packages/contracts/project-sync.ts does not exist.

- [ ] **Step 3: Implement list, replay, sequence gate, and replacement**

The per-epoch operation must replace the snapshot rather than take the maximum cursor:

        const runEpoch = <E, R>(
          source: ProjectSyncSource<E, R>,
          sink: ProjectSyncSink
        ): Effect.Effect<void, E, R> =>
          Effect.gen(function* () {
            const initial = yield* source.list()
            const current = yield* Ref.make(initial)
            yield* Effect.sync(() => sink.snapshot(initial))
            yield* source.events({ fromSeq: initial.seq }).pipe(
              Stream.runForEach((sequenced) =>
                Ref.modify(current, (snapshot) => {
                  if (sequenced.seq <= snapshot.seq) {
                    return [Option.none<ProjectSnapshot>(), snapshot] as const
                  }
                  const next = {
                    projects: Project.foldList(snapshot.projects, sequenced.event),
                    seq: sequenced.seq
                  }
                  return [Option.some(next), next] as const
                }).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.void,
                      onSome: (snapshot) => Effect.sync(() => sink.snapshot(snapshot))
                    })
                  )
                )
              )
            )
          })

runProjectSync must forward every status to the sink, execute one runEpoch for each connected status, catch list/event errors inside that epoch, retain the last sink value, and remain alive until interrupted. It must not contain a readable project ref in its public API.

- [ ] **Step 4: Write and run the real integration test**

Use two ClientLayer runtimes against one backend. Start runProjectSync from client B, mutate through client A, and assert B's sink reaches the returned event sequence and folded project value.

Run:

    bun --bun vitest run packages/contracts/test/project-sync.test.ts packages/client-ts/test/integration/project-sync.test.ts

Expected: PASS.

- [ ] **Step 5: Export the synchronization API and typecheck**

The existing wildcard contract export exposes packages/contracts/project-sync.ts as @expand/contracts/project-sync. Import that exact subpath from desktop, TUI, and the client-ts integration test; do not re-export it from @expand/client-ts/project.

Run:

    bun run typecheck
    bun run --cwd packages/contracts build

Expected: both commands PASS.

- [ ] **Step 6: Commit**

    git add packages/contracts/project-sync.ts packages/contracts/test/project-sync.test.ts packages/client-ts/test/integration/project-sync.test.ts
    git commit -m "feat: add project synchronization"

---

### Task 4: Replace desktop main's project projection with transparent session forwarding

**Files:**
- Modify: apps/desktop/src/main/runtime.ts
- Modify: apps/desktop/src/main/rpc/project-handlers.ts
- Modify: apps/desktop/src/main/rpc/connection-handlers.ts
- Modify: apps/desktop/src/main/rpc/health-handlers.ts
- Modify: apps/desktop/src/main/rpc/server.ts
- Modify: apps/desktop/src/main/rpc/transport.ts
- Modify: apps/desktop/src/main/index.ts
- Rewrite: apps/desktop/test/integration/rpc-handlers.test.ts
- Rewrite: apps/desktop/test/integration/connection-honesty.test.ts
- Modify: apps/desktop/test/integration/rpc-server.test.ts
- Modify: apps/desktop/test/integration/transport.test.ts

**Interfaces:**
- Consumes: ClientLayer, ClientSession, ProjectClient, ServerClient.
- Produces: desktop main ManagedRuntime<ClientSession | ProjectClient | ServerClient, BackendUnavailable>.
- Contract: Events forwards fromSeq to the backend; main owns no project array or cursor.

- [ ] **Step 1: Rewrite handler tests against session and domain-client stubs**

Replace fake ProjectStore layers with one merged layer containing ClientSession, ProjectClient, and ServerClient. Add these exact assertions:

        it("ProjectList and commands delegate to ProjectClient", async () => {
          const result = await runProjectHandlers()
          expect(result.createPayload).toEqual({
            name: "omega",
            ensure: true,
            directory: "/srv/omega"
          })
          expect(result.listPayload).toEqual({ includeArchived: true })
        })

        it("Events forwards fromSeq to the upstream epoch", async () => {
          const requested = await collectEventRequest(17)
          expect(requested).toEqual({ fromSeq: 17 })
        })

        it("Connect reflects ClientSession status transitions", async () => {
          const values = await collectConnect(["connected", "reconnecting", "connected"])
          expect(values).toEqual([true, false, true])
        })

        it("Health delegates only while connected", async () => {
          const result = await runHealthStatusScenario()
          expect(result.connected).toBe("ok")
          expect(Exit.isFailure(result.reconnecting)).toBe(true)
        })

- [ ] **Step 2: Run desktop integration tests and verify the old boundary fails**

Run:

    bun --bun vitest run apps/desktop/test/integration/connection-honesty.test.ts apps/desktop/test/integration/rpc-handlers.test.ts apps/desktop/test/integration/rpc-server.test.ts apps/desktop/test/integration/transport.test.ts

Expected: FAIL because handlers still require ProjectStore and Events filters its local hub.

- [ ] **Step 3: Rewire runtime and request handlers**

makeRuntime must use ClientLayer(makeNodeAdapter(...)). Project handlers must delegate directly:

        ProjectCreate: (payload) =>
          dieOnRpcClientError(
            Effect.flatMap(ProjectClient, (client) => client.create(payload))
          ),
        ProjectRename: (payload) =>
          dieOnRpcClientError(
            Effect.flatMap(ProjectClient, (client) => client.rename(payload))
          ),
        ProjectList: (payload) =>
          dieOnRpcClientError(
            Effect.flatMap(ProjectClient, (client) => client.list(payload))
          )

Apply the same one-to-one delegation for changeDirectory, archive, restore, setMetadata, and delete. Do not reconstruct ProjectCreateResult and do not read or mutate local state.

- [ ] **Step 4: Rewire stream and health handlers**

Implement:

        Connect: () =>
          Stream.unwrap(
            Effect.map(ClientSession, (session) =>
              SubscriptionRef.changes(session.status).pipe(
                Stream.map((status) => status === "connected")
              )
            )
          ),
        Events: (payload) =>
          Stream.unwrap(
            Effect.map(ProjectClient, (client) => client.events(payload))
          )

Health must first observe connected status and then delegate to ServerClient.health. A reconnecting status dies with the existing backend-disconnected error.

- [ ] **Step 5: Update environment types and run the focused suite**

Update main index IPC binding, runRpcServer, and connectPort environment types from ProjectStore to ClientSession | ProjectClient | ServerClient.

Run:

    bun --bun vitest run apps/desktop/test/integration/connection-honesty.test.ts apps/desktop/test/integration/rpc-handlers.test.ts apps/desktop/test/integration/rpc-server.test.ts apps/desktop/test/integration/transport.test.ts
    bun run typecheck:desktop

Expected: PASS.

- [ ] **Step 6: Commit**

    git add apps/desktop/src/main apps/desktop/test/integration
    git commit -m "refactor: proxy desktop through client session"

---

### Task 5: Replace the desktop renderer bridge with boot-scoped Zustand

**Files:**
- Rewrite: apps/desktop/src/renderer/features/projects/data/project-store.ts
- Create: apps/desktop/src/renderer/features/projects/data/project-context.tsx
- Modify: apps/desktop/src/renderer/features/projects/data/use-projects.ts
- Modify: apps/desktop/src/renderer/rpc/project-rpc.ts
- Modify: apps/desktop/src/renderer/app/runtime.ts
- Modify: apps/desktop/src/renderer/main.tsx
- Delete: apps/desktop/src/renderer/app/app-handle.ts
- Delete: apps/desktop/src/renderer/app/AppHandleProvider.tsx
- Delete: apps/desktop/src/renderer/rpc/server-rpc.ts
- Rewrite: apps/desktop/test/ui/_harness.tsx
- Create: apps/desktop/test/unit/project-store.test.ts
- Create: apps/desktop/test/unit/project-context.test.tsx
- Modify: apps/desktop/test/unit/project-rpc.test.ts
- Modify: apps/desktop/test/unit/renderer-feature-layout.test.ts
- Delete: apps/desktop/test/unit/app-handle.test.ts
- Delete: apps/desktop/test/unit/renderer-project-store.test.ts
- Create: apps/desktop/test/integration/project-reconnect-sync.test.ts

**Interfaces:**
- Consumes: runProjectSync, ProjectSnapshot, and ProjectSyncSink from @expand/contracts/project-sync, plus ProjectRpcApi.
- Produces:

        export interface ProjectState extends ProjectSnapshot {
          readonly status: ProjectSyncStatus
        }

        export type ProjectsStore = StoreApi<ProjectState>

        export interface ProjectContextValue {
          readonly store: ProjectsStore
          readonly rpc: ProjectRpcApi
        }

- [ ] **Step 1: Write failing Zustand and context tests**

Add:

        it("creates independent stores for renderer boots", () => {
          const first = makeProjectsStore()
          const second = makeProjectsStore()
          first.setState({ projects: [alpha], seq: 1 })
          expect(second.getState()).toEqual({
            projects: [],
            seq: 0,
            status: "disconnected"
          })
        })

        it("publishes projects and seq atomically", () => {
          const store = makeProjectsStore()
          makeProjectSyncSink(store).snapshot({ projects: [alpha], seq: 7 })
          expect(store.getState()).toMatchObject({ projects: [alpha], seq: 7 })
        })

        it("updates selector consumers without an AppHandle mirror", () => {
          const store = makeProjectsStore()
          render(
            <ProjectContextProvider value={{ store, rpc }}>
              <ProjectNames />
            </ProjectContextProvider>
          )
          act(() => makeProjectSyncSink(store).snapshot({ projects: [alpha], seq: 1 }))
          expect(screen.getByText("alpha")).toBeDefined()
        })

Update ProjectRpc tests to assert Connect maps true to connected and false to reconnecting, and Events forwards its fromSeq unchanged.

- [ ] **Step 2: Run the renderer unit tests and verify they fail**

Run:

    bun --bun vitest run apps/desktop/test/unit/project-store.test.ts apps/desktop/test/unit/project-context.test.tsx apps/desktop/test/unit/project-rpc.test.ts

Expected: FAIL because the Zustand store and context do not exist.

- [ ] **Step 3: Implement the vanilla store and React context**

project-store.ts must contain only Zustand state construction and sink adaptation:

        export const makeProjectsStore = (): ProjectsStore =>
          createStore<ProjectState>()(() => ({
            projects: [],
            seq: 0,
            status: "disconnected"
          }))

        export const makeProjectSyncSink = (
          store: ProjectsStore
        ): ProjectSyncSink => ({
          snapshot: (snapshot) => store.setState(snapshot),
          status: (status) => store.setState({ status })
        })

project-context.tsx provides ProjectContextValue and implements selector access with useStore(value.store, selector). It must not call useSyncExternalStore directly.

- [ ] **Step 4: Rewire renderer RPC and hooks**

ProjectRpcApi keeps command/list methods and adds:

        readonly status: Stream.Stream<ProjectSyncStatus, RpcClientError.RpcClientError>
        readonly events: (
          payload: { readonly fromSeq: number }
        ) => Stream.Stream<SequencedEvent, RpcClientError.RpcClientError>

Map client.Connect() booleans to connected or reconnecting. useProjects reads state through the context selector. Mutation hooks run ProjectRpc Effects with Effect.runPromise and retain the existing per-hook pending/error state; they never call store.setState from mutation results.

- [ ] **Step 5: Rewire boot and remove AppHandle**

After acquiring the MessagePort, boot must:

1. Build ProjectRpc over RendererRpcClient.
2. Create one ProjectsStore.
3. Start scoped runProjectSync with rpc.status, rpc.list({ includeArchived: true }), and rpc.events.
4. Wait until the sink receives its first snapshot.
5. Mount one ProjectContextProvider value containing that store and rpc.
6. Keep the Effect scope alive until renderer shutdown.

main.tsx renders ProjectContextProvider instead of AppHandleProvider. Delete AppHandle, AppHandleProvider, ServerRpc, and their obsolete tests.

- [ ] **Step 6: Add the renderer-through-main reconnect regression**

Use the real cloning port pair, main RPC server, renderer RPC client, ProjectRpc, runProjectSync, and ProjectsStore. Script:

        expect(store.getState()).toMatchObject({ projects: [alpha], seq: 1 })
        yield* publishStatus("reconnecting")
        yield* replaceAuthoritativeSnapshot({ projects: [beta], seq: 5 })
        expect(store.getState()).toMatchObject({ projects: [alpha], seq: 1 })
        yield* publishStatus("connected")
        yield* awaitStoreSeq(store, 5)
        expect(store.getState()).toMatchObject({ projects: [beta], seq: 5 })
        expect(eventRequests).toEqual([{ fromSeq: 1 }, { fromSeq: 5 }])

The test name is resnapshots missed external changes after an upstream reconnect. Interrupt synchronization and assert later scripted delivery does not change the store.

- [ ] **Step 7: Run renderer, UI, and desktop type tests**

Run:

    bun --bun vitest run apps/desktop/test/unit/project-store.test.ts apps/desktop/test/unit/project-context.test.tsx apps/desktop/test/unit/project-rpc.test.ts apps/desktop/test/unit/use-mutation-state.test.tsx apps/desktop/test/integration/project-reconnect-sync.test.ts apps/desktop/test/ui
    bun run typecheck:desktop

Expected: PASS.

- [ ] **Step 8: Commit**

    git add -A apps/desktop/src/renderer apps/desktop/test
    git commit -m "refactor: own project state in desktop"

---

### Task 6: Move TUI synchronization into React-local state

**Files:**
- Modify: apps/tui/runtime.ts
- Modify: apps/tui/use-projects.ts
- Create: apps/tui/test/ui/_runtime-harness.ts
- Rewrite: apps/tui/test/ui/use-projects.test.tsx
- Modify: apps/tui/test/ui/app-archive.test.tsx
- Modify: apps/tui/test/ui/app-delete.test.tsx
- Modify: apps/tui/test/ui/app-input-routing.test.tsx
- Modify: apps/tui/test/ui/app-mutation-error.test.tsx

**Interfaces:**
- Consumes: ClientLayer, ClientSession, ProjectClient, and runProjectSync from @expand/contracts/project-sync.
- Produces: RuntimeContext backed by ClientSession | ProjectClient | ServerClient and useProjects with React-owned ProjectSnapshot.

- [ ] **Step 1: Create the shared TUI runtime harness and failing hook tests**

The harness provides controllable ClientSession.status, ProjectClient.list/events, command stubs, and synchronization cleanup observation. Add:

        it("publishes the initial synchronized snapshot", async () => {
          renderHookWithRuntime()
          await waitForFrame("alpha")
          expect(observedSnapshot()).toEqual({ projects: [alpha], seq: 1 })
        })

        it("retains projects while reconnecting and replaces after resnapshot", async () => {
          const view = renderHookWithRuntime()
          await view.waitForProjects(["alpha"])
          view.status.set("reconnecting")
          view.authoritative.set({ projects: [beta], seq: 5 })
          expect(view.projects()).toEqual(["alpha"])
          view.status.set("connected")
          await view.waitForProjects(["beta"])
        })

        it("interrupts synchronization on unmount", async () => {
          const view = renderHookWithRuntime()
          view.unmount()
          expect(await view.syncInterrupted()).toBe(true)
        })

- [ ] **Step 2: Run the TUI hook tests and verify the old fake store boundary fails**

Run:

    bun --bun vitest run apps/tui/test/ui/use-projects.test.tsx

Expected: FAIL because runtime and hooks still require ProjectStore.

- [ ] **Step 3: Rewire the TUI runtime**

makeProductionRuntime provides ClientLayer(makeBunAdapter(...)) with BunServices. RuntimeContext carries the resulting ClientSession | ProjectClient | ServerClient environment and no ProjectStore.

- [ ] **Step 4: Rewire useProjects**

The hook owns:

        const [snapshot, setSnapshot] = useState<ProjectSnapshot>({
          projects: [],
          seq: 0
        })
        const [error, setError] = useState<string | null>(null)

On mount, run an Effect that resolves ClientSession and ProjectClient, then starts runProjectSync with:

        {
          status: SubscriptionRef.changes(session.status),
          list: () => client.list({ includeArchived: true }),
          events: ({ fromSeq }) => client.events({ fromSeq })
        }

The sink uses setSnapshot and does not alter projects from mutation responses. Attach an observer to the returned fiber so initial layer-build failure still reaches setError. Interrupt the fiber in the effect cleanup.

Mutations flatMap ProjectClient and preserve create ensure semantics:

        create: (name) => client.create({ name, ensure: true })
        rename: (id, name) => client.rename({ id, name })
        changeDirectory: (id, directory) => client.changeDirectory({ id, directory })
        archive: (id) => client.archive({ id })
        restore: (id) => client.restore({ id })
        setMetadata: (id, patch) => client.setMetadata({ id, ...patch })
        deleteProject: (id) => client.delete({ id })

- [ ] **Step 5: Replace repeated fake stores in TUI UI tests**

Use _runtime-harness.ts in archive, delete, input-routing, mutation-error, and use-projects tests. Retain every existing user-visible behavior assertion and add live event, reconnect replacement, and unmount cleanup assertions.

- [ ] **Step 6: Run all TUI tests and typecheck**

Run:

    bun --bun vitest run apps/tui/test
    bun run typecheck

Expected: PASS.

- [ ] **Step 7: Commit**

    git add apps/tui
    git commit -m "refactor: own project state in tui"

---

### Task 7: Delete ProjectStore and finish public migration

**Files:**
- Delete: packages/client-ts/project/store.ts
- Delete: packages/client-ts/test/unit/subscribe-ref.test.ts
- Delete: packages/client-ts/test/integration/project-store.test.ts
- Delete: packages/client-ts/test/integration/cross-store-sync.test.ts
- Delete: packages/client-ts/test/integration/bootstrap-window.test.ts
- Delete: packages/client-ts/test/integration/snapshot-consistency.test.ts
- Delete: packages/client-ts/test/integration/reconnect.test.ts
- Modify: packages/client-ts/test/unit/entrypoints.test.ts
- Modify: packages/client-ts/project/index.ts
- Modify: packages/client-ts/index.ts
- Modify: packages/client-ts/README.md
- Modify: packages/client-ts/ARCHITECTURE.md
- Modify: packages/client-ts/tsup.config.ts

**Interfaces:**
- Consumes: all replacement APIs and migrated app consumers from Tasks 1-6.
- Produces: final client-ts surface with ClientSession, final @expand/contracts/project-sync surface with runProjectSync, and no ProjectStore compatibility.

- [ ] **Step 1: Change entrypoint tests to require the final API**

Assert:

        expect(root.ClientSession).toBeDefined()
        expect(root.ClientSessionLayer).toBeDefined()
        expect(project.ProjectClient).toBeDefined()
        expect(project.ProjectStore).toBeUndefined()
        expect(project.ProjectStoreLayer).toBeUndefined()
        expect(root.ProjectStore).toBeUndefined()

- [ ] **Step 2: Run entrypoint and architecture tests in the red state**

Run:

    bun --bun vitest run packages/client-ts/test/unit/entrypoints.test.ts test/architecture

Expected: FAIL while project/index.ts still exports ProjectStore and public docs still describe it.

- [ ] **Step 3: Delete the old implementation and superseded tests**

Delete the listed store file and tests only after their guarantees exist in client-session.test.ts, project-sync.test.ts, project-reconnect-sync.test.ts, and TUI tests. Remove all runtime imports and exports of ProjectStore, ProjectStoreLayer, ProjectStoreApi, subscribeRef, and RendererProjectStore.

- [ ] **Step 4: Rewrite public documentation**

README and ARCHITECTURE must describe:

- ClientSession as connection and reconnect infrastructure.
- ProjectClient and ServerClient as session-backed typed facades.
- @expand/contracts/project-sync as the renderer-safe framework-neutral list/replay controller.
- desktop Zustand, TUI React state, and stateless CLI as application-owned state choices.
- list then Events({ fromSeq }) as the race-free bootstrap.
- fresh-list replacement after reconnect.

Remove examples that instantiate ProjectStoreLayer or subscribe to store.projects. Delete the stale tsup comment lines that name the removed ExpandRpcClient service; do not replace them with new code comments.

- [ ] **Step 5: Prove the old surface is absent**

Run:

    rg -n 'ProjectStore|ProjectStoreLayer|ProjectStoreApi|subscribeRef|RendererProjectStore' packages apps test --glob '!docs/superpowers/**'

Expected: no production or public-documentation matches. Explicit negative entrypoint assertions may match and are allowed.

- [ ] **Step 6: Run package and application verification**

Run:

    bun run typecheck:all
    bun run lint
    bun run arch
    bun --bun vitest run packages/client-ts/test apps/cli/test apps/tui/test apps/desktop/test
    bun run --cwd packages/contracts build
    bun run --cwd packages/client-ts build
    bun run build:desktop

Expected: every command exits 0.

- [ ] **Step 7: Commit**

    git add -A packages/client-ts apps test
    git commit -m "refactor: remove shared project store"

---

## Whole-branch completion gates

After Task 7 passes its task-review gate:

1. Dispatch the project-scoped code-reviewer across the complete branch relative to feat/architectural-foundation.
2. Send all Critical and Important findings in one consolidated wave to a fresh tdd-implementer.
3. Run a fresh task-reviewer over that fix wave and repeat until no Critical or Important findings remain.
4. Use superpowers:verification-before-completion and independently run:

       bun run typecheck:all
       bun run lint
       bun run arch
       bun run knip
       bun --bun vitest run
       bun run build
       bun run --cwd packages/client-ts build
       bun run build:desktop

5. Audit the approved design requirement by requirement against source, tests, exports, documentation, build output, and search results.
6. Use superpowers:finishing-a-development-branch.
7. Record the dirty state of /home/gimhoff/projects/expand, create a named safety stash including untracked files if needed, fast-forward feat/architectural-foundation to feature/client-state-boundary, and restore the stash.
8. Discard restored hunks only when they target files deliberately deleted or replaced by this migration; preserve all unrelated user changes.
9. Verify the target checkout's branch, HEAD, status, and restored changes before marking the goal complete.
