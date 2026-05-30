import { Context, Effect, Layer, Stream, SubscriptionRef } from "effect"
import { RpcClient, type RpcClientError } from "effect/unstable/rpc"
import type { FileSystem, Scope } from "effect"
import type { Project } from "@yodea/contracts/project"
import { YodeaRpcs } from "@yodea/contracts/rpc"
import type { RuntimeAdapter } from "@yodea/client-core/adapter"
import { findOrSpawnBackend } from "@yodea/client-core/discovery"

export interface ProjectStoreShape {
  // Reactive list: current snapshot + every future ProjectCreated, folded in.
  readonly projects: SubscriptionRef.SubscriptionRef<ReadonlyArray<Project>>
  // Issue a create over the held connection (server emits the event we fold).
  readonly createProject: (name: string) => Effect.Effect<Project, RpcClientError.RpcClientError>
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

    // Snapshot, then live fold of ProjectCreated.
    const initial = yield* client.ProjectList()
    yield* SubscriptionRef.set(projects, initial)
    yield* Effect.forkScoped(
      Stream.runForEach(client.Events(), (event) =>
        event._tag === "ProjectCreated"
          ? SubscriptionRef.update(projects, (cur) =>
              cur.some((p) => p.id === event.projectId)
                ? cur
                : [...cur, { id: event.projectId, name: event.name, createdAt: event.createdAt }])
          : Effect.void)
    )

    return { projects, createProject: (name: string) => client.ProjectCreate({ name }) }
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
