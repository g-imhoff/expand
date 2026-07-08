import { Layer } from "effect"
import type { FileSystem } from "effect"
import type { BackendUnavailable } from "@expand/client-core/discovery"
import type { RuntimeAdapter } from "@expand/client-core/adapter"
import { ProjectClient, ProjectClientLive } from "@expand/client-core/project-client"
import { ServerClient, ServerClientLive } from "@expand/client-core/server-client"
import { ExpandRpcClientLive } from "@expand/client-core/rpc-client"

export const ClientLayer = (
  adapter: RuntimeAdapter
): Layer.Layer<ProjectClient | ServerClient, BackendUnavailable, FileSystem.FileSystem> =>
  Layer.mergeAll(ProjectClientLive, ServerClientLive).pipe(Layer.provide(ExpandRpcClientLive(adapter)))
