import { Context, Effect, Layer, Queue, Ref, Stream, SubscriptionRef } from "effect"
import type { Schema } from "effect"
import type { RpcClientError } from "effect/unstable/rpc"
import { Project, ProjectName, Tag, type ProjectId } from "@yodea/contracts/project"
import type { ProjectDeleteResult } from "@yodea/contracts/project"
import type { SequencedEvent } from "@yodea/contracts/events/domain"
import type {
  ProjectDirectoryConflict,
  ProjectDirectoryInvalid,
  ProjectNameConflict,
  ProjectNotFound
} from "@yodea/contracts/rpc"
import { ProjectRpc } from "@yodea/desktop/renderer/rpc/project-rpc"
import { supervised } from "@yodea/desktop/renderer/lib/supervised"

export interface RendererProjectStoreShape {
  readonly projects: SubscriptionRef.SubscriptionRef<ReadonlyArray<Project>>
  readonly createProject: (
    name: string
  ) => Effect.Effect<Project, Schema.SchemaError | RpcClientError.RpcClientError | ProjectDirectoryInvalid | ProjectDirectoryConflict>
  readonly renameProject: (args: { readonly id: ProjectId; readonly name: string }) => Effect.Effect<
    Project,
    Schema.SchemaError | RpcClientError.RpcClientError | ProjectNotFound | ProjectNameConflict
  >
  readonly changeDirectory: (args: { readonly id: ProjectId; readonly directory: string }) => Effect.Effect<
    Project,
    RpcClientError.RpcClientError | ProjectNotFound | ProjectDirectoryInvalid | ProjectDirectoryConflict
  >
  readonly archiveProject: (id: ProjectId) => Effect.Effect<Project, RpcClientError.RpcClientError | ProjectNotFound>
  readonly restoreProject: (id: ProjectId) => Effect.Effect<Project, RpcClientError.RpcClientError | ProjectNotFound>
  readonly setMetadata: (args: {
    readonly id: ProjectId
    readonly description?: string | null
    readonly tags?: ReadonlyArray<string>
  }) => Effect.Effect<Project, Schema.SchemaError | RpcClientError.RpcClientError | ProjectNotFound>
  readonly deleteProject: (
    id: ProjectId
  ) => Effect.Effect<ProjectDeleteResult, RpcClientError.RpcClientError | ProjectNotFound>
}

export class RendererProjectStore extends Context.Service<RendererProjectStore, RendererProjectStoreShape>()(
  "yodea/desktop/RendererProjectStore"
) {}

export const RendererProjectStoreLayer: Layer.Layer<RendererProjectStore, never, ProjectRpc> = Layer.effect(
  RendererProjectStore,
  Effect.gen(function* () {
    const rpc = yield* ProjectRpc
    const projects = yield* SubscriptionRef.make<ReadonlyArray<Project>>([])

    const buffer = yield* Queue.unbounded<SequencedEvent>()

    yield* Effect.forkScoped(
      supervised(
        "renderer project-store events pump",
        Stream.runForEach(rpc.events(), (se) => Queue.offer(buffer, se)).pipe(Effect.orDie)
      )
    )

    const initial = yield* rpc.list({ includeArchived: true }).pipe(Effect.orDie)
    yield* SubscriptionRef.set(projects, initial.projects)
    const lastSeq = yield* Ref.make(initial.seq)

    yield* Effect.forkScoped(
      supervised(
        "renderer project-store event fold",
        Queue.take(buffer).pipe(
          Effect.flatMap((se) =>
            Effect.flatMap(Ref.get(lastSeq), (last) =>
              se.seq <= last
                ? Effect.void
                : SubscriptionRef.update(projects, (cur) => Project.foldList(cur, se.event)).pipe(
                    Effect.andThen(Ref.set(lastSeq, se.seq))
                  )
            )
          ),
          Effect.forever
        )
      )
    )

    return {
      projects,
      createProject: (name) =>
        ProjectName.makeEffect(name).pipe(
          Effect.flatMap((n) => rpc.create({ name: n, ensure: true })),
          // `ensure: true` guarantees the backend never reports ProjectAlreadyExists,
          // so the store narrows it out of its error channel (it can only ever be a defect).
          Effect.catchTag("ProjectAlreadyExists", (e) => Effect.die(e)),
          Effect.map((r) => r.project)
        ),
      renameProject: (args) =>
        ProjectName.makeEffect(args.name).pipe(
          Effect.flatMap((n) => rpc.rename({ id: args.id, name: n }))
        ),
      changeDirectory: (args) => rpc.changeDirectory(args),
      archiveProject: (id) => rpc.archive({ id }),
      restoreProject: (id) => rpc.restore({ id }),
      setMetadata: (args) =>
        Effect.flatMap(
          args.tags === undefined
            ? Effect.succeed<ReadonlyArray<Tag> | undefined>(undefined)
            : Effect.forEach(args.tags, (t) => Tag.makeEffect(t)),
          (tags) =>
            rpc.setMetadata({
              id: args.id,
              ...(args.description !== undefined ? { description: args.description } : {}),
              ...(tags !== undefined ? { tags } : {})
            })
        ),
      deleteProject: (id) => rpc.delete({ id })
    }
  })
)
