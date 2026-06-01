import { Effect, type Scope } from "effect"
import { RpcServer, type RpcGroup, type RpcMessage } from "effect/unstable/rpc"
import { YodeaRpcs } from "@yodea/contracts/rpc"
import { ProjectStore } from "@yodea/client-core"
import { DesktopRpcHandlers } from "@yodea/desktop/main/rpc/handlers"

// The contract's Rpc union, extracted from the group via the RpcGroup.Rpcs helper.
type Rpcs = RpcGroup.Rpcs<typeof YodeaRpcs>

// Build a serialization-free RpcServer for the contract. `onFromServer` is how
// the server emits decoded responses back to its one client (one server per
// window/port). The handler layer (which requires ProjectStore) is provided
// here; ProjectStore + Scope are supplied by the caller's runtime.
export const makeRpcServer = (
  onFromServer: (response: RpcMessage.FromServer<Rpcs>) => Effect.Effect<void>
): Effect.Effect<RpcServer.RpcServer<Rpcs>, never, ProjectStore | Scope.Scope> =>
  RpcServer.makeNoSerialization(YodeaRpcs, { onFromServer }).pipe(Effect.provide(DesktopRpcHandlers))
