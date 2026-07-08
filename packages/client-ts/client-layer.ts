import { Layer } from "effect"
import type { FileSystem } from "effect"
import type { BackendUnavailable } from "@expand/client-ts/errors"
import type { RuntimeAdapter } from "@expand/client-ts/adapter"
import { ProjectClient, ProjectClientLive } from "@expand/client-ts/project-client"
import { ServerClient, ServerClientLive } from "@expand/client-ts/server-client"
import { ExpandRpcClientLayer } from "@expand/client-ts/rpc-client"

export const ClientLayer = (
  adapter: RuntimeAdapter
): Layer.Layer<ProjectClient | ServerClient, BackendUnavailable, FileSystem.FileSystem> =>
  Layer.mergeAll(ProjectClientLive, ServerClientLive).pipe(Layer.provide(ExpandRpcClientLayer(adapter)))
