import { Effect } from "effect"
import type { RuntimeAdapter } from "./adapter"
import { ClientSession, ClientSessionLayer } from "./client-session"
import type { ExpandRpcClientApi } from "./rpc-client"

export const withClient = <A, E, R>(
  adapter: RuntimeAdapter,
  use: (client: ExpandRpcClientApi) => Effect.Effect<A, E, R>
) =>
  Effect.flatMap(ClientSession, (session) => Effect.flatMap(session.current, use)).pipe(
    Effect.scoped,
    Effect.provide(ClientSessionLayer(adapter))
  )
