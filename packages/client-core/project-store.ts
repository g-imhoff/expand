import { Cause, Context, Deferred, Effect, Exit, Layer, PubSub, Queue, Schedule, Stream, SubscriptionRef } from "effect"
import { RpcClient, type RpcClientError } from "effect/unstable/rpc"
import type { FileSystem, Scope } from "effect"
import type { Project, ProjectDeleteResult } from "@yodea/contracts/project"
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
    name: string,
    directory?: string | null
  ) => Effect.Effect<Project, RpcClientError.RpcClientError | ProjectDirectoryInvalid | ProjectDirectoryConflict>
  readonly renameProject: (
    id: string,
    name: string
  ) => Effect.Effect<Project, RpcClientError.RpcClientError | ProjectNotFound | ProjectNameConflict>
  readonly changeDirectory: (
    id: string,
    directory: string
  ) => Effect.Effect<Project, RpcClientError.RpcClientError | ProjectNotFound | ProjectDirectoryInvalid | ProjectDirectoryConflict>
  readonly archiveProject: (id: string) => Effect.Effect<Project, RpcClientError.RpcClientError | ProjectNotFound>
  readonly restoreProject: (id: string) => Effect.Effect<Project, RpcClientError.RpcClientError | ProjectNotFound>
  readonly setMetadata: (
    id: string,
    patch: { description?: string | null; tags?: ReadonlyArray<string> }
  ) => Effect.Effect<Project, RpcClientError.RpcClientError | ProjectNotFound>
  readonly deleteProject: (id: string) => Effect.Effect<ProjectDeleteResult, RpcClientError.RpcClientError | ProjectNotFound>
  readonly events: Stream.Stream<SequencedEvent>
}

export class ProjectStore extends Context.Service<ProjectStore, ProjectStoreShape>()(
  "yodea/ProjectStore"
) {}

const applyEvent = (
  projects: SubscriptionRef.SubscriptionRef<ReadonlyArray<Project>>,
  event: DomainEvent
): Effect.Effect<void> => {
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
              createdAt: event.occurredAt,
              updatedAt: event.occurredAt
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
      return SubscriptionRef.update(projects, (cur) => cur.filter((p) => p.id !== event.projectId))
    default:
      return Effect.void
  }
}

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
          onConnect: SubscriptionRef.set(status, "connected"),
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
      createProject: (name: string, directory?: string | null) =>
        current.pipe(
          Effect.flatMap((client) =>
            client.ProjectCreate({ name, ensure: true, ...(directory !== undefined ? { directory } : {}) })
          ),
          Effect.map((r) => r.project),
          Effect.catchTag("ProjectAlreadyExists", (e) => Effect.die(e))
        ),
      renameProject: (id: string, name: string) =>
        current.pipe(Effect.flatMap((client) => client.ProjectRename({ id, name }))),
      changeDirectory: (id: string, directory: string) =>
        current.pipe(Effect.flatMap((client) => client.ProjectChangeDirectory({ id, directory }))),
      archiveProject: (id: string) =>
        current.pipe(Effect.flatMap((client) => client.ProjectArchive({ id }))),
      restoreProject: (id: string) =>
        current.pipe(Effect.flatMap((client) => client.ProjectRestore({ id }))),
      setMetadata: (id: string, patch: { description?: string | null; tags?: ReadonlyArray<string> }) =>
        current.pipe(
          Effect.flatMap((client) =>
            client.ProjectSetMetadata({
              id,
              ...(patch.description !== undefined ? { description: patch.description } : {}),
              ...(patch.tags !== undefined ? { tags: patch.tags } : {})
            })
          )
        ),
      deleteProject: (id: string) =>
        current.pipe(Effect.flatMap((client) => client.ProjectDelete({ id })))
    }
  })

export const ProjectStoreLayer = (
  adapter: RuntimeAdapter
): Layer.Layer<ProjectStore, BackendUnavailable, FileSystem.FileSystem> =>
  Layer.effect(ProjectStore, makeStore(adapter))
