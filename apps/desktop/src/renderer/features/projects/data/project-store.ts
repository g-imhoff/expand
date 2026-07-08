import { Context, Effect, Layer, Queue, Ref, Stream, SubscriptionRef } from "effect"
import type { RpcClientError } from "effect/unstable/rpc"
import { Project } from "@expand/contracts/project"
import type { ProjectDeleteResult } from "@expand/contracts/project"
import type { SequencedEvent } from "@expand/contracts/events/domain"
import type {
  ProjectDirectoryConflict,
  ProjectDirectoryInvalid,
  ProjectInvalidInput,
  ProjectNameConflict,
  ProjectNotFound
} from "@expand/contracts/rpc"
import { ProjectRpc } from "@expand/desktop/renderer/rpc/project-rpc"
import { supervised } from "@expand/desktop/renderer/lib/supervised"

// Mutations take raw strings and forward them to the backend, which validates at
// ingestion (ProjectInvalidInput on failure). The renderer never brands.
export interface RendererProjectStoreShape {
  readonly projects: SubscriptionRef.SubscriptionRef<ReadonlyArray<Project>>
  readonly createProject: (
    name: string
  ) => Effect.Effect<Project, RpcClientError.RpcClientError | ProjectDirectoryInvalid | ProjectDirectoryConflict | ProjectInvalidInput>
  readonly renameProject: (args: { readonly id: string; readonly name: string }) => Effect.Effect<
    Project,
    RpcClientError.RpcClientError | ProjectNotFound | ProjectNameConflict | ProjectInvalidInput
  >
  readonly changeDirectory: (args: { readonly id: string; readonly directory: string }) => Effect.Effect<
    Project,
    RpcClientError.RpcClientError | ProjectNotFound | ProjectDirectoryInvalid | ProjectDirectoryConflict
  >
  readonly archiveProject: (id: string) => Effect.Effect<Project, RpcClientError.RpcClientError | ProjectNotFound>
  readonly restoreProject: (id: string) => Effect.Effect<Project, RpcClientError.RpcClientError | ProjectNotFound>
  readonly setMetadata: (args: {
    readonly id: string
    readonly description?: string | null
    readonly tags?: ReadonlyArray<string>
  }) => Effect.Effect<Project, RpcClientError.RpcClientError | ProjectNotFound | ProjectInvalidInput>
  readonly deleteProject: (
    id: string
  ) => Effect.Effect<ProjectDeleteResult, RpcClientError.RpcClientError | ProjectNotFound>
}

export class RendererProjectStore extends Context.Service<RendererProjectStore, RendererProjectStoreShape>()(
  "expand/desktop/RendererProjectStore"
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
        rpc.create({ name, ensure: true }).pipe(
          // `ensure: true` guarantees the backend never reports ProjectAlreadyExists,
          // so the store narrows it out of its error channel (it can only ever be a defect).
          Effect.catchTag("ProjectAlreadyExists", (e) => Effect.die(e)),
          Effect.map((r) => r.project)
        ),
      renameProject: (args) => rpc.rename({ id: args.id, name: args.name }),
      changeDirectory: (args) => rpc.changeDirectory(args),
      archiveProject: (id) => rpc.archive({ id }),
      restoreProject: (id) => rpc.restore({ id }),
      setMetadata: (args) =>
        rpc.setMetadata({
          id: args.id,
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.tags !== undefined ? { tags: args.tags } : {})
        }),
      deleteProject: (id) => rpc.delete({ id })
    }
  })
)
