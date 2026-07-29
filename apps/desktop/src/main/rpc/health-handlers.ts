import { Effect, SubscriptionRef } from "effect"
import type { RpcGroup } from "effect/unstable/rpc"
import { ExpandRpcs } from "@expand/contracts/rpc"
import { ClientSession } from "@expand/client-ts"
import { ServerClient } from "@expand/client-ts/server"
import { dieOnRpcClientError } from "@expand/desktop/main/rpc/guard"

export const healthHandlers: Pick<Handlers, "Health"> = {
  Health: Effect.fn("DesktopRpc.Health")(() =>
    Effect.flatMap(ClientSession, (session) =>
      Effect.flatMap(SubscriptionRef.get(session.status), (status) =>
        status === "connected"
          ? dieOnRpcClientError(Effect.flatMap(ServerClient, (client) => client.health()))
          : Effect.die(new Error("backend disconnected"))
      )
    )
  )
}

type Handlers = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof ExpandRpcs>>
