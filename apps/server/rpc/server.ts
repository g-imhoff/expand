import { Effect } from "effect"
import type { RpcGroup } from "effect/unstable/rpc"
import { ExpandRpcs } from "@expand/contracts/rpc"
import { ServerUseCases } from "@expand/server/application/server/use-cases"

export const serverHandlers = {
  Health: () => Effect.flatMap(ServerUseCases, (u) => u.health)
} satisfies Pick<Handlers, "Health">

type Handlers = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof ExpandRpcs>>
