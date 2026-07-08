import { Effect } from "effect"
import type { RuntimeAdapter } from "@expand/client-ts/adapter"
import { ExpandRpcClient, ExpandRpcClientLayer, type ExpandRpcClientApi } from "@expand/client-ts/rpc-client"

export const withClient = <A, E, R>(
  adapter: RuntimeAdapter,
  use: (client: ExpandRpcClientApi) => Effect.Effect<A, E, R>
) =>
  Effect.flatMap(ExpandRpcClient, use).pipe(Effect.scoped, Effect.provide(ExpandRpcClientLayer(adapter)))
