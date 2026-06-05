import { Effect } from "effect"
import type { RuntimeAdapter } from "@yodea/client-core/adapter"
import { YodeaRpcClient, YodeaRpcClientLive, type YodeaRpcClientApi } from "@yodea/client-core/rpc-client"

export const withClient = <A, E, R>(
  adapter: RuntimeAdapter,
  use: (client: YodeaRpcClientApi) => Effect.Effect<A, E, R>
) =>
  Effect.flatMap(YodeaRpcClient, use).pipe(Effect.scoped, Effect.provide(YodeaRpcClientLive(adapter)))
