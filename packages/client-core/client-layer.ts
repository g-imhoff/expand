import { Layer } from "effect"
import type { FileSystem } from "effect"
import type { AppContext } from "@yodea/contracts/app-context"
import type { BackendUnavailable } from "@yodea/client-core/discovery"
import type { RuntimeAdapter } from "@yodea/client-core/adapter"
import { ProjectClient, ProjectClientLive } from "@yodea/client-core/project-client"
import { ServerClient, ServerClientLive } from "@yodea/client-core/server-client"
import { YodeaRpcClientLive } from "@yodea/client-core/rpc-client"

export const ClientLayer = (
  adapter: RuntimeAdapter
): Layer.Layer<ProjectClient | ServerClient, BackendUnavailable, FileSystem.FileSystem | AppContext> =>
  Layer.mergeAll(ProjectClientLive, ServerClientLive).pipe(Layer.provide(YodeaRpcClientLive(adapter)))
