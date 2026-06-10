import { Context, Effect, Layer } from "effect"
import type { FileSystem } from "effect"
import type { RpcClientError } from "effect/unstable/rpc"
import type { Project, ProjectCreateResult, ProjectDeleteResult } from "@yodea/contracts/project"
import type { ProjectAlreadyExists, ProjectDirectoryConflict, ProjectDirectoryInvalid, ProjectNameConflict, ProjectNotFound } from "@yodea/contracts/rpc"
import type { BackendUnavailable } from "@yodea/client-core/discovery"
import type { RuntimeAdapter } from "@yodea/client-core/adapter"
import { YodeaRpcClient, YodeaRpcClientLive } from "@yodea/client-core/rpc-client"

export interface ProjectClientApi {
  readonly create: (payload: {
    readonly name: string
    readonly ensure: boolean
    readonly directory?: string | null
  }) => Effect.Effect<ProjectCreateResult, RpcClientError.RpcClientError | ProjectAlreadyExists | ProjectDirectoryInvalid | ProjectDirectoryConflict>
  readonly rename: (payload: { readonly id: string; readonly name: string }) => Effect.Effect<Project, RpcClientError.RpcClientError | ProjectNotFound | ProjectNameConflict>
  readonly changeDirectory: (payload: { readonly id: string; readonly directory: string }) => Effect.Effect<Project, RpcClientError.RpcClientError | ProjectNotFound | ProjectDirectoryInvalid | ProjectDirectoryConflict>
  readonly archive: (payload: { readonly id: string }) => Effect.Effect<Project, RpcClientError.RpcClientError | ProjectNotFound>
  readonly restore: (payload: { readonly id: string }) => Effect.Effect<Project, RpcClientError.RpcClientError | ProjectNotFound>
  readonly setMetadata: (payload: {
    readonly id: string
    readonly description?: string | null
    readonly tags?: ReadonlyArray<string>
  }) => Effect.Effect<Project, RpcClientError.RpcClientError | ProjectNotFound>
  readonly delete: (payload: { readonly id: string }) => Effect.Effect<ProjectDeleteResult, RpcClientError.RpcClientError | ProjectNotFound>
  readonly list: (payload?: { readonly includeArchived?: boolean }) => Effect.Effect<
    { readonly projects: ReadonlyArray<Project>; readonly seq: number },
    RpcClientError.RpcClientError
  >
}

export class ProjectClient extends Context.Service<ProjectClient, ProjectClientApi>()(
  "yodea/ProjectClient"
) {}

export const ProjectClientLive: Layer.Layer<ProjectClient, never, YodeaRpcClient> = Layer.effect(
  ProjectClient,
  Effect.map(YodeaRpcClient, (client): ProjectClientApi => ({
    create: (payload) => client.ProjectCreate(payload),
    rename: (payload) => client.ProjectRename(payload),
    changeDirectory: (payload) => client.ProjectChangeDirectory(payload),
    archive: (payload) => client.ProjectArchive(payload),
    restore: (payload) => client.ProjectRestore(payload),
    setMetadata: (payload) => client.ProjectSetMetadata(payload),
    delete: (payload) => client.ProjectDelete(payload),
    list: (payload = {}) => client.ProjectList(payload)
  }))
)

export const ProjectClientLayer = (
  adapter: RuntimeAdapter
): Layer.Layer<ProjectClient, BackendUnavailable, FileSystem.FileSystem> =>
  ProjectClientLive.pipe(Layer.provide(YodeaRpcClientLive(adapter)))
