import { Context, Effect, Layer, PubSub, Queue, Ref, Stream, SubscriptionRef } from "effect"
import { RpcClient, type RpcClientError } from "effect/unstable/rpc"
import type { FileSystem, Scope } from "effect"
import type { Project, ProjectDeleteResult } from "@yodea/contracts/project"
import type { DomainEvent, SequencedEvent } from "@yodea/contracts/events/domain"
import { YodeaRpcs } from "@yodea/contracts/rpc"
import type { ProjectDirectoryConflict, ProjectDirectoryInvalid, ProjectNameConflict, ProjectNotFound } from "@yodea/contracts/rpc"
import type { RuntimeAdapter } from "@yodea/client-core/adapter"
import { findOrSpawnBackend } from "@yodea/client-core/discovery"
import { endpointWsUrl } from "@yodea/client-core/rpc-client"
import { supervised } from "@yodea/client-core/supervise"

export interface ProjectStoreShape {
  readonly projects: SubscriptionRef.SubscriptionRef<ReadonlyArray<Project>>
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

const makeStore = (adapter: RuntimeAdapter): Effect.Effect<
  ProjectStoreShape,
  never,
  FileSystem.FileSystem | Scope.Scope
> =>
  Effect.gen(function* () {
    const endpoint = yield* findOrSpawnBackend(adapter)
    const projects = yield* SubscriptionRef.make<ReadonlyArray<Project>>([])

    const protocol = yield* Layer.build(adapter.protocolLayer(endpointWsUrl(endpoint)))
    const client = yield* RpcClient.make(YodeaRpcs).pipe(Effect.provideContext(protocol))

    yield* Effect.forkScoped(supervised("project-store connect drain", Stream.runDrain(client.Connect())))

    const events = yield* client.Events({}, { asQueue: true })

    const initial = yield* client.ProjectList({ includeArchived: true })
    yield* SubscriptionRef.set(projects, initial.projects)
    const lastSeq = yield* Ref.make(initial.seq)

    const hub = yield* PubSub.unbounded<SequencedEvent>()

    const applyEvent = (event: DomainEvent): Effect.Effect<void> => {
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

    yield* Effect.forkScoped(
      supervised("project-store event fold",
        Queue.take(events).pipe(
          Effect.flatMap((se) =>
            PubSub.publish(hub, se).pipe(
              Effect.andThen(applyEvent(se.event)),
              Effect.andThen(Ref.update(lastSeq, (n) => Math.max(n, se.seq)))
            )
          ),
          Effect.forever
        )
      )
    )

    const snapshot = Effect.gen(function* () {
      const seq = yield* Ref.get(lastSeq)
      const ps = yield* SubscriptionRef.get(projects)
      return { projects: ps, seq }
    })

    return {
      projects,
      snapshot,
      events: Stream.fromPubSub(hub),
      createProject: (name: string, directory?: string | null) =>
        client.ProjectCreate({ name, ensure: true, ...(directory !== undefined ? { directory } : {}) }).pipe(
          Effect.map((r) => r.project),
          Effect.catchTag("ProjectAlreadyExists", (e) => Effect.die(e))
        ),
      renameProject: (id: string, name: string) => client.ProjectRename({ id, name }),
      changeDirectory: (id: string, directory: string) => client.ProjectChangeDirectory({ id, directory }),
      archiveProject: (id: string) => client.ProjectArchive({ id }),
      restoreProject: (id: string) => client.ProjectRestore({ id }),
      setMetadata: (id: string, patch: { description?: string | null; tags?: ReadonlyArray<string> }) =>
        client.ProjectSetMetadata({
          id,
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          ...(patch.tags !== undefined ? { tags: patch.tags } : {})
        }),
      deleteProject: (id: string) => client.ProjectDelete({ id })
    }
  }).pipe(Effect.orDie)

export const ProjectStoreLayer = (adapter: RuntimeAdapter): Layer.Layer<ProjectStore, never, FileSystem.FileSystem> =>
  Layer.effect(ProjectStore, makeStore(adapter))
