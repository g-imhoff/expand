import { Layer } from "effect"
import type { Crypto, FileSystem, Path } from "effect"
import type { AppContext } from "@expand/contracts/app-context"
import type { ProcessControl } from "@expand/contracts/process-control"
import type { BackendUnavailable } from "./errors"
import type { RuntimeAdapter } from "./adapter"
import type { BackendConnection } from "@expand/contracts/backend-connection"
import { ClientSession, ClientSessionLayer } from "./client-session"
import { ProjectClient, ProjectClientLive } from "./project/client"
import { ServerClient, ServerClientLive } from "./server/client"
import { AutomationClient, AutomationClientLive } from "./automation/client"

export const ClientLayer = (
  adapter: RuntimeAdapter,
  connection?: BackendConnection
): Layer.Layer<
  ClientSession | ProjectClient | ServerClient | AutomationClient,
  BackendUnavailable,
  FileSystem.FileSystem | Path.Path | Crypto.Crypto | AppContext | ProcessControl
> =>
  Layer.mergeAll(ProjectClientLive, ServerClientLive, AutomationClientLive).pipe(
    Layer.provideMerge(ClientSessionLayer(adapter, connection))
  )
