import { Context, Effect, Layer, PubSub, Queue, Stream, SubscriptionRef } from "effect"
import { RpcClient, type RpcClientError } from "effect/unstable/rpc"
import type { FileSystem, Scope } from "effect"
import type { Project, ProjectDeleteResult } from "@yodea/contracts/project"
import type { DomainEvent } from "@yodea/contracts/events"
import { YodeaRpcs } from "@yodea/contracts/rpc"
import type { ProjectDirectoryConflict, ProjectDirectoryInvalid, ProjectNameConflict, ProjectNotFound } from "@yodea/contracts/rpc"
import type { RuntimeAdapter } from "@yodea/client-core/adapter"
import { findOrSpawnBackend } from "@yodea/client-core/discovery"

export interface ProjectStoreShape {
  // Reactive list: current snapshot + every future ProjectCreated, folded in.
  readonly projects: SubscriptionRef.SubscriptionRef<ReadonlyArray<Project>>
  // Issue a create over the held connection (server emits the event we fold).
  // `directory` is optional (D2); when given it is validated server-side.
  readonly createProject: (
    name: string,
    directory?: string | null
  ) => Effect.Effect<Project, RpcClientError.RpcClientError | ProjectDirectoryInvalid | ProjectDirectoryConflict>
  // Rename over the held connection. Unlike createProject, this SURFACES the typed
  // domain errors (ProjectNotFound/ProjectNameConflict) so TUI/desktop can react.
  readonly renameProject: (
    id: string,
    name: string
  ) => Effect.Effect<Project, RpcClientError.RpcClientError | ProjectNotFound | ProjectNameConflict>
  // Change-directory over the held connection. SURFACES the typed domain errors
  // (ProjectNotFound/ProjectDirectoryInvalid/ProjectDirectoryConflict) so
  // TUI/desktop can react.
  readonly changeDirectory: (
    id: string,
    directory: string
  ) => Effect.Effect<Project, RpcClientError.RpcClientError | ProjectNotFound | ProjectDirectoryInvalid | ProjectDirectoryConflict>
  // Archive/restore over the held connection. SURFACE the typed ProjectNotFound
  // (does NOT Effect.die it) so TUI/desktop can react.
  readonly archiveProject: (id: string) => Effect.Effect<Project, RpcClientError.RpcClientError | ProjectNotFound>
  readonly restoreProject: (id: string) => Effect.Effect<Project, RpcClientError.RpcClientError | ProjectNotFound>
  // Set-metadata (replace-style) over the held connection. SURFACES the typed
  // ProjectNotFound (does NOT Effect.die it) so TUI/desktop can react.
  readonly setMetadata: (
    id: string,
    patch: { description?: string | null; tags?: ReadonlyArray<string> }
  ) => Effect.Effect<Project, RpcClientError.RpcClientError | ProjectNotFound>
  // Soft-delete a project (server emits ProjectDeleted, folded out of the ref).
  // Surfaces the typed ProjectNotFound so TUI/desktop can react (unlike create).
  readonly deleteProject: (id: string) => Effect.Effect<ProjectDeleteResult, RpcClientError.RpcClientError | ProjectNotFound>
  // Live stream of every DomainEvent the backend commits, for additional
  // subscribers (e.g. each Electron window's RpcServer). Live-only, like the
  // backend's own Events stream: a subscriber sees events emitted AFTER it attaches.
  readonly events: Stream.Stream<DomainEvent>
}

// Ground truth (Task 2.1 Step 3): Context.Service<Self, Shape>()("id") accepts
// being called with NO `{make}` (the options arg is optional when R is
// unassigned). The real implementation is always supplied by
// ProjectStoreLayer(adapter) below, so we omit `make` entirely.
export class ProjectStore extends Context.Service<ProjectStore, ProjectStoreShape>()(
  "yodea/ProjectStore"
) {}

// Build the store on the AMBIENT (layer/runtime) scope so the connection,
// presence fiber, and Events-fold fiber live until the runtime is disposed.
const makeStore = (adapter: RuntimeAdapter): Effect.Effect<
  ProjectStoreShape,
  never,
  FileSystem.FileSystem | Scope.Scope
> =>
  Effect.gen(function* () {
    const endpoint = yield* findOrSpawnBackend(adapter)
    const projects = yield* SubscriptionRef.make<ReadonlyArray<Project>>([])

    // Transport built into the ambient scope -> the client outlives this gen.
    const protocol = yield* Layer.build(adapter.protocolLayer(endpoint.url))
    const client = yield* RpcClient.make(YodeaRpcs).pipe(Effect.provideContext(protocol))

    // I-4 presence: held open for the whole scope (drop => backend may shut down).
    yield* Effect.forkScoped(Stream.runDrain(client.Connect()))

    // Open the live Events stream as a QUEUE *synchronously in this fiber* (rather
    // than evaluating `client.Events()` lazily inside a forked `Stream.runForEach`).
    // This sends the stream-open request IN ORDER, before the snapshot below — and
    // critically before `createProject` can ever be called by a consumer. The
    // server's Events handler is `Stream.fromPubSub` over an unbounded PubSub, which
    // only delivers events emitted AFTER the subscription is registered; lazily
    // forking the subscribe let an immediate create race ahead of it (the event was
    // published before the server saw our subscribe, so it was never pushed). Over
    // Bun's WebSocket the fork happened to win that race; over the Node `ws`
    // transport it lost, and the ref stayed []. The queue's lifecycle is bound to
    // this (ambient) scope, so it is torn down with the runtime like the old fork.
    const events = yield* client.Events(undefined, { asQueue: true })

    // Snapshot. Because requests travel a single ordered socket, ProjectList's
    // response can only arrive after the server has processed the earlier Events
    // subscribe — so this round-trip doubles as a barrier proving the subscription
    // is live before we return (and thus before the first possible createProject).
    const initial = yield* client.ProjectList({})
    yield* SubscriptionRef.set(projects, initial)

    // Re-broadcast hub: the fold loop publishes every event here so external
    // subscribers (each window's RpcServer) get their own live subscription,
    // without competing for the single `events` queue. Bound to the ambient scope.
    const hub = yield* PubSub.unbounded<DomainEvent>()

    // Fold every future event into the ref AND re-publish to the hub. Mirrors the
    // server (apps/cli/domain/project.ts) and desktop renderer folds: each arm
    // stamps updatedAt from the event time; unknown tags are a no-op.
    yield* Effect.forkScoped(
      Queue.take(events).pipe(
        Effect.flatMap((event) =>
          Effect.andThen(
            PubSub.publish(hub, event),
            (() => {
              switch (event._tag) {
                case "ProjectCreated":
                  return SubscriptionRef.update(projects, (cur) =>
                    cur.some((p) => p.id === event.projectId)
                      ? cur
                      : [...cur, {
                          id: event.projectId,
                          name: event.name,
                          directory: event.directory ?? null,
                          description: null,
                          tags: [],
                          archived: false,
                          createdAt: event.createdAt,
                          updatedAt: event.createdAt
                        }])
                case "ProjectRenamed":
                  return SubscriptionRef.update(projects, (cur) =>
                    cur.map((p) =>
                      p.id === event.projectId ? { ...p, name: event.name, updatedAt: event.occurredAt } : p))
                case "ProjectDirectoryChanged":
                  return SubscriptionRef.update(projects, (cur) =>
                    cur.map((p) =>
                      p.id === event.projectId ? { ...p, directory: event.directory, updatedAt: event.occurredAt } : p))
                case "ProjectArchived":
                  return SubscriptionRef.update(projects, (cur) =>
                    cur.map((p) =>
                      p.id === event.projectId ? { ...p, archived: true, updatedAt: event.occurredAt } : p))
                case "ProjectRestored":
                  return SubscriptionRef.update(projects, (cur) =>
                    cur.map((p) =>
                      p.id === event.projectId ? { ...p, archived: false, updatedAt: event.occurredAt } : p))
                case "ProjectMetadataChanged":
                  return SubscriptionRef.update(projects, (cur) =>
                    cur.map((p) =>
                      p.id === event.projectId
                        ? {
                            ...p,
                            ...(event.description !== undefined ? { description: event.description } : {}),
                            ...(event.tags !== undefined ? { tags: [...new Set(event.tags)] } : {}),
                            updatedAt: event.occurredAt
                          }
                        : p))
                case "ProjectDeleted":
                  // Tombstone: drop the project from the ref (filter on an absent
                  // id is a no-op — out-of-order tolerance, matching the server fold).
                  return SubscriptionRef.update(projects, (cur) => cur.filter((p) => p.id !== event.projectId))
                default:
                  return Effect.void
              }
            })()
          )
        ),
        Effect.forever
      )
    )

    // Idempotent create (ensure: true) keeps createProject's error type to
    // RpcClientError only (no ProjectAlreadyExists leaking into the TUI/desktop
    // bridges) while still yielding a Project. With ensure: true the server never
    // returns ProjectAlreadyExists, so discharge that (impossible) tag as a defect.
    return {
      projects,
      events: Stream.fromPubSub(hub),
      createProject: (name: string, directory?: string | null) =>
        client.ProjectCreate({ name, ensure: true, ...(directory !== undefined ? { directory } : {}) }).pipe(
          Effect.map((r) => r.project),
          Effect.catchTag("ProjectAlreadyExists", (e) => Effect.die(e))
        ),
      // Surfaces ProjectNotFound/ProjectNameConflict (does NOT Effect.die them).
      renameProject: (id: string, name: string) => client.ProjectRename({ id, name }),
      // Surfaces ProjectNotFound/ProjectDirectoryInvalid/ProjectDirectoryConflict
      // (does NOT Effect.die them).
      changeDirectory: (id: string, directory: string) => client.ProjectChangeDirectory({ id, directory }),
      // Surface ProjectNotFound (does NOT Effect.die it).
      archiveProject: (id: string) => client.ProjectArchive({ id }),
      restoreProject: (id: string) => client.ProjectRestore({ id }),
      // Replace-style metadata. Surfaces ProjectNotFound (does NOT Effect.die it).
      // Only the provided fields are sent (present description incl. null / present
      // tags); absent keys leave that field unchanged server-side.
      setMetadata: (id: string, patch: { description?: string | null; tags?: ReadonlyArray<string> }) =>
        client.ProjectSetMetadata({
          id,
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          ...(patch.tags !== undefined ? { tags: patch.tags } : {})
        }),
      // Soft-delete. Surfaces ProjectNotFound (does NOT Effect.die it); the
      // ProjectDeleted event folds the project out of the ref via the loop above.
      deleteProject: (id: string) => client.ProjectDelete({ id })
    }
    // Store CONSTRUCTION failures (backend unreachable, snapshot RPC error) are
    // unrecoverable startup conditions, not part of the running store's surface —
    // matching the plan's `never`-error layer signature. `Effect.orDie` discharges
    // them as defects (the same convention the server's rpc-handlers use). The
    // running store's typed error stays on `createProject` (RpcClientError).
  }).pipe(Effect.orDie)

// Parameterized layer: the adapter is captured in closure (URL is only known at
// runtime, so the transport can't be a static layer dependency).
export const ProjectStoreLayer = (adapter: RuntimeAdapter): Layer.Layer<ProjectStore, never, FileSystem.FileSystem> =>
  Layer.effect(ProjectStore, makeStore(adapter))
