import { Context, Effect, Layer, Stream } from "effect"
import type { FileSystem } from "effect"
import type { RpcClientError } from "effect/unstable/rpc"
import type { SequencedEvent } from "@expand/contracts/events/domain"
import type { Project, ProjectCreateResult, ProjectDeleteResult } from "@expand/contracts/project"
import type { AppContext } from "@expand/contracts/app-context"
import type { ProjectAlreadyExists, ProjectDirectoryConflict, ProjectDirectoryInvalid, ProjectInvalidInput, ProjectNameConflict, ProjectNotFound } from "@expand/contracts/rpc"
import type { BackendUnavailable } from "../errors"
import type { RuntimeAdapter } from "../adapter"
import { ClientSession, ClientSessionLayer } from "../client-session"

// Raw strings in; the backend validates at ingestion (ProjectInvalidInput on
// failure). The client never references the branded vocabulary.
export interface ProjectClientApi {
  readonly create: (payload: {
    readonly name: string
    readonly ensure: boolean
    readonly directory?: string | null
  }) => Effect.Effect<ProjectCreateResult, RpcClientError.RpcClientError | ProjectAlreadyExists | ProjectDirectoryInvalid | ProjectDirectoryConflict | ProjectInvalidInput>
  readonly rename: (payload: { readonly id: string; readonly name: string }) => Effect.Effect<Project, RpcClientError.RpcClientError | ProjectNotFound | ProjectNameConflict | ProjectInvalidInput>
  readonly changeDirectory: (payload: { readonly id: string; readonly directory: string }) => Effect.Effect<Project, RpcClientError.RpcClientError | ProjectNotFound | ProjectDirectoryInvalid | ProjectDirectoryConflict>
  readonly archive: (payload: { readonly id: string }) => Effect.Effect<Project, RpcClientError.RpcClientError | ProjectNotFound>
  readonly restore: (payload: { readonly id: string }) => Effect.Effect<Project, RpcClientError.RpcClientError | ProjectNotFound>
  readonly setMetadata: (payload: {
    readonly id: string
    readonly description?: string | null
    readonly tags?: ReadonlyArray<string>
  }) => Effect.Effect<Project, RpcClientError.RpcClientError | ProjectNotFound | ProjectInvalidInput>
  readonly delete: (payload: { readonly id: string }) => Effect.Effect<ProjectDeleteResult, RpcClientError.RpcClientError | ProjectNotFound>
  readonly list: (payload?: { readonly includeArchived?: boolean }) => Effect.Effect<
    { readonly projects: ReadonlyArray<Project>; readonly seq: number },
    RpcClientError.RpcClientError
  >
  readonly events: (
    payload?: { readonly fromSeq?: number }
  ) => Stream.Stream<SequencedEvent, RpcClientError.RpcClientError>
}

export class ProjectClient extends Context.Service<ProjectClient, ProjectClientApi>()(
  "expand/ProjectClient"
) {}

/** @internal */
export const ProjectClientLive: Layer.Layer<ProjectClient, never, ClientSession> = Layer.effect(
  ProjectClient,
  Effect.map(ClientSession, (session): ProjectClientApi => ({
    create: (payload) =>
      Effect.flatMap(session.current, (client) => client.ProjectCreate(payload)),
    rename: (payload) =>
      Effect.flatMap(session.current, (client) => client.ProjectRename(payload)),
    changeDirectory: (payload) =>
      Effect.flatMap(session.current, (client) => client.ProjectChangeDirectory(payload)),
    archive: (payload) =>
      Effect.flatMap(session.current, (client) => client.ProjectArchive(payload)),
    restore: (payload) =>
      Effect.flatMap(session.current, (client) => client.ProjectRestore(payload)),
    setMetadata: (payload) =>
      Effect.flatMap(session.current, (client) => client.ProjectSetMetadata(payload)),
    delete: (payload) =>
      Effect.flatMap(session.current, (client) => client.ProjectDelete(payload)),
    list: (payload = {}) =>
      Effect.flatMap(session.current, (client) => client.ProjectList(payload)),
    events: (payload = {}) =>
      Stream.unwrap(
        Effect.map(session.current, (client) => client.Events(payload))
      )
  }))
)

export const ProjectClientLayer = (
  adapter: RuntimeAdapter
): Layer.Layer<ProjectClient, BackendUnavailable, FileSystem.FileSystem | AppContext> =>
  ProjectClientLive.pipe(Layer.provide(ClientSessionLayer(adapter)))
