import { Context, Effect, Layer, Stream, SubscriptionRef } from "effect"
import type { RpcClientError } from "effect/unstable/rpc"
import type { Project, ProjectDeleteResult } from "@yodea/contracts/project"
import type {
  ProjectDirectoryConflict,
  ProjectDirectoryInvalid,
  ProjectNameConflict,
  ProjectNotFound
} from "@yodea/contracts/rpc"
import { ProjectRpc } from "@yodea/desktop/renderer/rpc/project-rpc"
import { foldEvent } from "@yodea/desktop/renderer/features/projects/model/event-fold"
import { supervised } from "@yodea/desktop/renderer/lib/supervised"

export interface RendererProjectStoreShape {
  readonly projects: SubscriptionRef.SubscriptionRef<ReadonlyArray<Project>>
  readonly createProject: (
    name: string
  ) => Effect.Effect<Project, RpcClientError.RpcClientError | ProjectDirectoryInvalid | ProjectDirectoryConflict>
  readonly renameProject: (args: { readonly id: string; readonly name: string }) => Effect.Effect<
    Project,
    RpcClientError.RpcClientError | ProjectNotFound | ProjectNameConflict
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
  }) => Effect.Effect<Project, RpcClientError.RpcClientError | ProjectNotFound>
  readonly deleteProject: (
    id: string
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

    const initial = yield* rpc.list({ includeArchived: true }).pipe(Effect.orDie)
    yield* SubscriptionRef.set(projects, initial.projects)

    yield* Effect.forkScoped(
      supervised(
        "renderer project-store event fold",
        Stream.runForEach(rpc.events(), (se) =>
          SubscriptionRef.update(projects, (cur) => foldEvent(cur, se.event))
        ).pipe(Effect.orDie)
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
      renameProject: (args) => rpc.rename(args),
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
