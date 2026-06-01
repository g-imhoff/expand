import { Effect } from "effect"
import { YodeaClient, YodeaClientLive, type YodeaClientApi } from "@yodea/client-core/yodea-client"
import type { RuntimeAdapter } from "@yodea/client-core/adapter"

// Backwards-compatible: discover-or-spawn, connect, establish the I-4 presence
// channel, run `use` in the connected scope, then tear everything down (dropping
// presence -> the server may shut down if we were the last connection). Now a
// thin wrapper over the `YodeaClientLive` scoped layer, which means every caller
// (TUI, desktop, e2e tests) exercises — and thereby proves — that live layer.
export const withClient = <A, E, R>(
  adapter: RuntimeAdapter,
  use: (client: YodeaClientApi) => Effect.Effect<A, E, R>
) =>
  Effect.flatMap(YodeaClient, use).pipe(Effect.scoped, Effect.provide(YodeaClientLive(adapter)))
