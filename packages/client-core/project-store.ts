import { Cause, Context, Deferred, Effect, Exit, Layer, PubSub, Queue, Schedule, Stream, SubscriptionRef } from "effect"
import { RpcClient, type RpcClientError } from "effect/unstable/rpc"
import type { FileSystem, Scope } from "effect"
import { Project } from "@yodea/contracts/project"
import type { ProjectCreateResult, ProjectDeleteResult, ProjectId, ProjectName, Tag } from "@yodea/contracts/project"
import type { DomainEvent, SequencedEvent } from "@yodea/contracts/events/domain"
import type { ProjectDirectoryConflict, ProjectDirectoryInvalid, ProjectNameConflict, ProjectNotFound } from "@yodea/contracts/rpc"
import type { RuntimeAdapter } from "@yodea/client-core/adapter"
import { BackendUnavailable } from "@yodea/client-core/discovery"
import { acquireClient, type YodeaRpcClientApi } from "@yodea/client-core/rpc-client"
import { supervised } from "@yodea/client-core/supervise"

export type ConnectionStatus = "connected" | "reconnecting" | "disconnected"

export interface ProjectStoreShape {
  readonly projects: SubscriptionRef.SubscriptionRef<ReadonlyArray<Project>>
  readonly status: SubscriptionRef.SubscriptionRef<ConnectionStatus>
  readonly snapshot: Effect.Effect<{ readonly projects: ReadonlyArray<Project>; readonly seq: number }>
  readonly createProject: (
    name: ProjectName,
    directory?: string | null
  ) => Effect.Effect<Project, RpcClientError.RpcClientError | ProjectDirectoryInvalid | ProjectDirectoryConflict>
  readonly renameProject: (
    id: ProjectId,
    name: ProjectName
  ) => Effect.Effect<Project, RpcClientError.RpcClientError | ProjectNotFound | ProjectNameConflict>
  readonly changeDirectory: (
    id: ProjectId,
    directory: string
  ) => Effect.Effect<Project, RpcClientError.RpcClientError | ProjectNotFound | ProjectDirectoryInvalid | ProjectDirectoryConflict>
  readonly archiveProject: (id: ProjectId) => Effect.Effect<Project, RpcClientError.RpcClientError | ProjectNotFound>
  readonly restoreProject: (id: ProjectId) => Effect.Effect<Project, RpcClientError.RpcClientError | ProjectNotFound>
  readonly setMetadata: (
    id: ProjectId,
    patch: { description?: string | null; tags?: ReadonlyArray<Tag> }
  ) => Effect.Effect<Project, RpcClientError.RpcClientError | ProjectNotFound>
  readonly deleteProject: (id: ProjectId) => Effect.Effect<ProjectDeleteResult, RpcClientError.RpcClientError | ProjectNotFound>
  readonly events: Stream.Stream<SequencedEvent>
}

export class ProjectStore extends Context.Service<ProjectStore, ProjectStoreShape>()(
  "yodea/ProjectStore"
) {}

const applyEvent = (
  projects: SubscriptionRef.SubscriptionRef<ReadonlyArray<Project>>,
  event: DomainEvent
): Effect.Effect<void> =>
  SubscriptionRef.update(projects, (cur) => Project.foldList(cur, event))

const reconnectPolicy = Schedule.exponential("500 millis", 1.5).pipe(
  Schedule.either(Schedule.spaced("5 seconds"))
)

const withConnectionHooks = (
  adapter: RuntimeAdapter,
  status: SubscriptionRef.SubscriptionRef<ConnectionStatus>
): RuntimeAdapter => ({
  ...adapter,
  protocolLayer: (url: string) =>
    adapter.protocolLayer(url).pipe(
      Layer.provide(
        Layer.succeed(RpcClient.ConnectionHooks, {
          onConnect: Effect.void,
          onDisconnect: SubscriptionRef.set(status, "reconnecting")
        })
      )
    )
})

const toUnavailable = (e: { readonly _tag: string }): BackendUnavailable =>
  e._tag === "BackendUnavailable"
    ? (e as BackendUnavailable)
    : new BackendUnavailable({ reason: String(e) })

const makeStore = (adapter: RuntimeAdapter): Effect.Effect<
  ProjectStoreShape,
  BackendUnavailable,
  FileSystem.FileSystem | Scope.Scope
> =>
  Effect.gen(function* () {
    const projects = yield* SubscriptionRef.make<ReadonlyArray<Project>>([])
    const status = yield* SubscriptionRef.make<ConnectionStatus>("disconnected")
    const hub = yield* PubSub.unbounded<SequencedEvent>()
    const lastSeq = yield* SubscriptionRef.make(0)
    const clientRef = yield* SubscriptionRef.make<YodeaRpcClientApi | null>(null)
    const ready = yield* Deferred.make<void, BackendUnavailable>()
    const hooked = withConnectionHooks(adapter, status)

    const session = Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* acquireClient(hooked)
        yield* SubscriptionRef.set(clientRef, client)
        const queue = yield* client.Events({}, { asQueue: true })
        const snapshot = yield* client.ProjectList({ includeArchived: true })
        yield* SubscriptionRef.update(lastSeq, (last) => Math.max(last, snapshot.seq))
        yield* SubscriptionRef.set(projects, snapshot.projects)
        yield* SubscriptionRef.set(status, "connected")
        yield* Deferred.succeed(ready, undefined)
        return yield* Queue.take(queue).pipe(
          Effect.flatMap((sequenced) =>
            Effect.flatMap(SubscriptionRef.get(lastSeq), (last) =>
              sequenced.seq <= last
                ? Effect.void
                : SubscriptionRef.set(lastSeq, sequenced.seq).pipe(
                    Effect.andThen(PubSub.publish(hub, sequenced)),
                    Effect.andThen(applyEvent(projects, sequenced.event))
                  )
            )
          ),
          Effect.forever
        )
      })
    )

    const connectionLoop = session.pipe(
      Effect.tapError((e) => Deferred.fail(ready, toUnavailable(e))),
      Effect.exit,
      Effect.flatMap((exit) =>
        Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
          ? Effect.failCause(exit.cause)
          : SubscriptionRef.set(status, "reconnecting").pipe(
              Effect.andThen(Effect.fail(new BackendUnavailable({ reason: "connection lost" })))
            )
      ),
      Effect.retry(reconnectPolicy)
    )

    yield* Effect.forkScoped(supervised("project-store-connection", connectionLoop))
    yield* Deferred.await(ready)

    const current = Effect.flatMap(SubscriptionRef.get(clientRef), (client) =>
      client === null ? Effect.die(new Error("rpc client not initialised")) : Effect.succeed(client)
    )

    return {
      projects,
      status,
      snapshot: Effect.flatMap(SubscriptionRef.get(projects), (ps) =>
        Effect.map(SubscriptionRef.get(lastSeq), (seq) => ({ projects: ps, seq }))
      ),
      events: Stream.fromPubSub(hub),
      createProject: (name: ProjectName, directory?: string | null) =>
        current.pipe(
          Effect.flatMap((client) =>
            client.ProjectCreate({ name, ensure: true, ...(directory !== undefined ? { directory } : {}) })
          ),
          Effect.map((r: ProjectCreateResult) => r.project),
          Effect.catchTag("ProjectAlreadyExists", (e) => Effect.die(e))
        ),
      renameProject: (id: ProjectId, name: ProjectName) =>
        current.pipe(Effect.flatMap((client) => client.ProjectRename({ id, name }))),
      changeDirectory: (id: ProjectId, directory: string) =>
        current.pipe(Effect.flatMap((client) => client.ProjectChangeDirectory({ id, directory }))),
      archiveProject: (id: ProjectId) =>
        current.pipe(Effect.flatMap((client) => client.ProjectArchive({ id }))),
      restoreProject: (id: ProjectId) =>
        current.pipe(Effect.flatMap((client) => client.ProjectRestore({ id }))),
      setMetadata: (id: ProjectId, patch: { description?: string | null; tags?: ReadonlyArray<Tag> }) =>
        current.pipe(
          Effect.flatMap((client) =>
            client.ProjectSetMetadata({
              id,
              ...(patch.description !== undefined ? { description: patch.description } : {}),
              ...(patch.tags !== undefined ? { tags: patch.tags } : {})
            })
          )
        ),
      deleteProject: (id: ProjectId) =>
        current.pipe(Effect.flatMap((client) => client.ProjectDelete({ id })))
    }
  })

export const ProjectStoreLayer = (
  adapter: RuntimeAdapter
): Layer.Layer<ProjectStore, BackendUnavailable, FileSystem.FileSystem> =>
  Layer.effect(ProjectStore, makeStore(adapter))
