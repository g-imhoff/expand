import { Layer } from "effect"
import type { Crypto, FileSystem, Path } from "effect"
import type { AppContext } from "@expand/contracts/app-context"
import type { ProcessControl } from "@expand/contracts/process-control"
import type { BackendUnavailable } from "./errors"
import type { RuntimeAdapter } from "./adapter"
import { ClientSession, ClientSessionLayer } from "./client-session"
import { ProjectClient, ProjectClientLive } from "./project/client"
import { ServerClient, ServerClientLive } from "./server/client"

export const ClientLayer = (
  adapter: RuntimeAdapter
): Layer.Layer<
  ClientSession | ProjectClient | ServerClient,
  BackendUnavailable,
  FileSystem.FileSystem | Path.Path | Crypto.Crypto | AppContext | ProcessControl
> =>
  Layer.mergeAll(ProjectClientLive, ServerClientLive).pipe(
    Layer.provideMerge(ClientSessionLayer(adapter))
  )
