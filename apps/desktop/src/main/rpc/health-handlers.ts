import { Effect } from "effect"
import type { RpcGroup } from "effect/unstable/rpc"
import { YodeaRpcs } from "@yodea/contracts/rpc"

type Handlers = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof YodeaRpcs>>

export const healthHandlers: Pick<Handlers, "Health"> = {
  Health: () => Effect.succeed("ok")
}
