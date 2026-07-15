import { Effect } from "effect"
import type { Crypto, FileSystem, Path } from "effect"
import type { AppContext } from "@expand/contracts/app-context"
import type { ProcessControl } from "@expand/contracts/process-control"
import type { RuntimeAdapter } from "./adapter"
import { ClientSession, ClientSessionLayer } from "./client-session"
import type { BackendUnavailable } from "./errors"
import type { ExpandRpcClientApi } from "./rpc-client"

export const withClient = Effect.fn("Client.withClient")(<A, E, R>(
  adapter: RuntimeAdapter,
  use: (client: ExpandRpcClientApi) => Effect.Effect<A, E, R>
): Effect.Effect<
  A,
  E | BackendUnavailable,
  R | FileSystem.FileSystem | Path.Path | Crypto.Crypto | AppContext | ProcessControl
> =>
  Effect.flatMap(ClientSession, (session) => Effect.flatMap(session.current, use)).pipe(
    Effect.scoped,
    Effect.provide(ClientSessionLayer(adapter))
  )
)
