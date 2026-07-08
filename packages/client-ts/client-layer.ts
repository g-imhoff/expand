import { Layer } from "effect"
import type { FileSystem } from "effect"
import type { BackendUnavailable } from "@expand/client-ts/discovery"
import type { RuntimeAdapter } from "@expand/client-ts/adapter"
import { ProjectClient, ProjectClientLive } from "@expand/client-ts/project-client"
import { ServerClient, ServerClientLive } from "@expand/client-ts/server-client"
import { ExpandRpcClientLive } from "@expand/client-ts/rpc-client"

export const ClientLayer = (
  adapter: RuntimeAdapter
): Layer.Layer<ProjectClient | ServerClient, BackendUnavailable, FileSystem.FileSystem> =>
  Layer.mergeAll(ProjectClientLive, ServerClientLive).pipe(Layer.provide(ExpandRpcClientLive(adapter)))
