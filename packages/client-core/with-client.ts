import { Effect } from "effect"
import type { RuntimeAdapter } from "@expand/client-core/adapter"
import { ExpandRpcClient, ExpandRpcClientLive, type ExpandRpcClientApi } from "@expand/client-core/rpc-client"

export const withClient = <A, E, R>(
  adapter: RuntimeAdapter,
  use: (client: ExpandRpcClientApi) => Effect.Effect<A, E, R>
) =>
  Effect.flatMap(ExpandRpcClient, use).pipe(Effect.scoped, Effect.provide(ExpandRpcClientLive(adapter)))
