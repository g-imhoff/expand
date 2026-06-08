import { Context, Effect, Layer, type Stream } from "effect"
import type { RpcClientError } from "effect/unstable/rpc"
import type { Project, ProjectCreateResult, ProjectDeleteResult } from "@yodea/contracts/project"
import type { DomainEvent } from "@yodea/contracts/events/domain"
import type {
  ProjectAlreadyExists,
  ProjectDirectoryConflict,
  ProjectDirectoryInvalid,
  ProjectNameConflict,
  ProjectNotFound
} from "@yodea/contracts/rpc"
import { RendererRpcClient } from "@yodea/desktop/renderer/rpc/transport"

export interface ProjectRpcApi {
  readonly create: (payload: {
    readonly name: string
    readonly ensure: boolean
    readonly directory?: string | null
  }) => Effect.Effect<
    ProjectCreateResult,
    RpcClientError.RpcClientError | ProjectAlreadyExists | ProjectDirectoryInvalid | ProjectDirectoryConflict
  >
  readonly rename: (payload: { readonly id: string; readonly name: string }) => Effect.Effect<
    Project,
    RpcClientError.RpcClientError | ProjectNotFound | ProjectNameConflict
  >
  readonly changeDirectory: (payload: { readonly id: string; readonly directory: string }) => Effect.Effect<
    Project,
    RpcClientError.RpcClientError | ProjectNotFound | ProjectDirectoryInvalid | ProjectDirectoryConflict
  >
  readonly archive: (payload: { readonly id: string }) => Effect.Effect<
    Project,
    RpcClientError.RpcClientError | ProjectNotFound
  >
  readonly restore: (payload: { readonly id: string }) => Effect.Effect<
    Project,
    RpcClientError.RpcClientError | ProjectNotFound
  >
  readonly setMetadata: (payload: {
    readonly id: string
    readonly description?: string | null
    readonly tags?: ReadonlyArray<string>
  }) => Effect.Effect<Project, RpcClientError.RpcClientError | ProjectNotFound>
  readonly delete: (payload: { readonly id: string }) => Effect.Effect<
    ProjectDeleteResult,
    RpcClientError.RpcClientError | ProjectNotFound
  >
  readonly list: (payload?: { readonly includeArchived?: boolean }) => Effect.Effect<
    ReadonlyArray<Project>,
    RpcClientError.RpcClientError
  >
  readonly events: () => Stream.Stream<DomainEvent, RpcClientError.RpcClientError>
}

export class ProjectRpc extends Context.Service<ProjectRpc, ProjectRpcApi>()(
  "yodea/desktop/ProjectRpc"
) {}

export const ProjectRpcLayer: Layer.Layer<ProjectRpc, never, RendererRpcClient> = Layer.effect(
  ProjectRpc,
  Effect.map(RendererRpcClient, (client): ProjectRpcApi => ({
    create: (p) => client.ProjectCreate(p),
    rename: (p) => client.ProjectRename(p),
    changeDirectory: (p) => client.ProjectChangeDirectory(p),
    archive: (p) => client.ProjectArchive(p),
    restore: (p) => client.ProjectRestore(p),
    setMetadata: (p) => client.ProjectSetMetadata(p),
    delete: (p) => client.ProjectDelete(p),
    list: (p = {}) => client.ProjectList(p),
    events: () => client.Events()
  }))
)
