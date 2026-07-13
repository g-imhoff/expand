import { Layer } from "effect"
import type { FileSystem } from "effect"
import type { BackendUnavailable } from "./errors"
import type { RuntimeAdapter } from "./adapter"
import { ClientSession, ClientSessionLayer } from "./client-session"
import { ProjectClient, ProjectClientLive } from "./project/client"
import { ServerClient, ServerClientLive } from "./server/client"

export const ClientLayer = (
  adapter: RuntimeAdapter
): Layer.Layer<ClientSession | ProjectClient | ServerClient, BackendUnavailable, FileSystem.FileSystem> =>
  Layer.mergeAll(ProjectClientLive, ServerClientLive).pipe(
    Layer.provideMerge(ClientSessionLayer(adapter))
  )
