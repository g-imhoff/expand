import { Effect, SubscriptionRef } from "effect"
import type { RpcGroup } from "effect/unstable/rpc"
import { YodeaRpcs } from "@yodea/contracts/rpc"
import { ProjectStore } from "@yodea/client-core"

type Handlers = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof YodeaRpcs>>

export const healthHandlers: Pick<Handlers, "Health"> = {
  Health: () =>
    Effect.flatMap(ProjectStore, (s) =>
      Effect.flatMap(SubscriptionRef.get(s.status), (status) =>
        status === "connected" ? Effect.succeed("ok") : Effect.die(new Error("backend disconnected"))
      )
    )
}
