import { Layer } from "effect"
import type { FileSystem } from "effect"
import type { BackendUnavailable } from "./errors"
import type { RuntimeAdapter } from "./adapter"
import { ProjectClient, ProjectClientLive } from "./project-client"
import { ServerClient, ServerClientLive } from "./server-client"
import { ExpandRpcClientLayer } from "./rpc-client"

export const ClientLayer = (
  adapter: RuntimeAdapter
): Layer.Layer<ProjectClient | ServerClient, BackendUnavailable, FileSystem.FileSystem> =>
  Layer.mergeAll(ProjectClientLive, ServerClientLive).pipe(Layer.provide(ExpandRpcClientLayer(adapter)))
