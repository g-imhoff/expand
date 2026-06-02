import { Context, Effect, Layer, PubSub, Queue, Stream, SubscriptionRef } from "effect"
import { RpcClient, type RpcClientError } from "effect/unstable/rpc"
import type { FileSystem, Scope } from "effect"
import type { Project } from "@yodea/contracts/project"
import type { DomainEvent } from "@yodea/contracts/events"
import { YodeaRpcs } from "@yodea/contracts/rpc"
import type { RuntimeAdapter } from "@yodea/client-core/adapter"
import { findOrSpawnBackend } from "@yodea/client-core/discovery"

export interface ProjectStoreShape {
  // Reactive list: current snapshot + every future ProjectCreated, folded in.
  readonly projects: SubscriptionRef.SubscriptionRef<ReadonlyArray<Project>>
  // Issue a create over the held connection (server emits the event we fold).
  readonly createProject: (name: string) => Effect.Effect<Project, RpcClientError.RpcClientError>
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
    const initial = yield* client.ProjectList()
    yield* SubscriptionRef.set(projects, initial)

    // Re-broadcast hub: the fold loop publishes every event here so external
    // subscribers (each window's RpcServer) get their own live subscription,
    // without competing for the single `events` queue. Bound to the ambient scope.
    const hub = yield* PubSub.unbounded<DomainEvent>()

    // Fold every future ProjectCreated into the ref AND re-publish to the hub.
    yield* Effect.forkScoped(
      Queue.take(events).pipe(
        Effect.flatMap((event) =>
          Effect.andThen(
            PubSub.publish(hub, event),
            event._tag === "ProjectCreated"
              ? SubscriptionRef.update(projects, (cur) =>
                  cur.some((p) => p.id === event.projectId)
                    ? cur
                    : [...cur, { id: event.projectId, name: event.name, createdAt: event.createdAt }])
              : Effect.void
          )
        ),
        Effect.forever
      )
    )

    return {
      projects,
      events: Stream.fromPubSub(hub),
      createProject: (name: string) => client.ProjectCreate({ name })
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
