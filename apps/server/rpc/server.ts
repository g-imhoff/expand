import { Effect } from "effect"
import type { RpcGroup } from "effect/unstable/rpc"
import { YodeaRpcs } from "@yodea/contracts/rpc"
import { ServerUseCases } from "@yodea/server/application/server/use-cases"

export const serverHandlers = {
  Health: () => Effect.flatMap(ServerUseCases, (u) => u.health)
} satisfies Pick<Handlers, "Health">

type Handlers = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof YodeaRpcs>>
