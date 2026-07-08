import { Effect, SubscriptionRef } from "effect"
import type { RpcGroup } from "effect/unstable/rpc"
import { ExpandRpcs } from "@expand/contracts/rpc"
import { ProjectStore } from "@expand/client-core"

export const healthHandlers: Pick<Handlers, "Health"> = {
  Health: () =>
    Effect.flatMap(ProjectStore, (s) =>
      Effect.flatMap(SubscriptionRef.get(s.status), (status) =>
        status === "connected" ? Effect.succeed("ok") : Effect.die(new Error("backend disconnected"))
      )
    )
}

type Handlers = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof ExpandRpcs>>
