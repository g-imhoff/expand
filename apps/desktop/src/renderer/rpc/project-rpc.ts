import { Context, Effect, Layer, Stream } from "effect"
import type { RpcClientError } from "effect/unstable/rpc"
import type { Project, ProjectCreateResult, ProjectDeleteResult } from "@expand/contracts/project"
import type { SequencedEvent } from "@expand/contracts/events/domain"
import type { ProjectSyncStatus } from "@expand/contracts/project-sync"
import type {
  ProjectAlreadyExists,
  ProjectDirectoryConflict,
  ProjectDirectoryInvalid,
  ProjectInvalidInput,
  ProjectNameConflict,
  ProjectNotFound
} from "@expand/contracts/rpc"
import { RendererRpcClient } from "@expand/desktop/renderer/rpc/transport"

// Raw strings in; the backend validates at ingestion (ProjectInvalidInput).
export interface ProjectRpcApi {
  readonly create: (payload: {
    readonly name: string
    readonly ensure: boolean
    readonly directory?: string | null
  }) => Effect.Effect<
    ProjectCreateResult,
    RpcClientError.RpcClientError | ProjectAlreadyExists | ProjectDirectoryInvalid | ProjectDirectoryConflict | ProjectInvalidInput
  >
  readonly rename: (payload: { readonly id: string; readonly name: string }) => Effect.Effect<
    Project,
    RpcClientError.RpcClientError | ProjectNotFound | ProjectNameConflict | ProjectInvalidInput
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
  }) => Effect.Effect<Project, RpcClientError.RpcClientError | ProjectNotFound | ProjectInvalidInput>
  readonly delete: (payload: { readonly id: string }) => Effect.Effect<
    ProjectDeleteResult,
    RpcClientError.RpcClientError | ProjectNotFound
  >
  readonly list: (payload?: { readonly includeArchived?: boolean }) => Effect.Effect<
    { readonly projects: ReadonlyArray<Project>; readonly seq: number },
    RpcClientError.RpcClientError
  >
  readonly status: Stream.Stream<ProjectSyncStatus, RpcClientError.RpcClientError>
  readonly events: (
    payload: { readonly fromSeq: number }
  ) => Stream.Stream<SequencedEvent, RpcClientError.RpcClientError>
}

export class ProjectRpc extends Context.Service<ProjectRpc, ProjectRpcApi>()(
  "expand/desktop/ProjectRpc"
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
    status: client.Connect().pipe(
      Stream.map((connected): ProjectSyncStatus => connected ? "connected" : "reconnecting")
    ),
    events: (payload) => client.Events(payload)
  }))
)
