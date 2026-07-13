import { Effect, Stream, SubscriptionRef } from "effect"
import type { RpcGroup } from "effect/unstable/rpc"
import { ExpandRpcs } from "@expand/contracts/rpc"
import { ClientSession } from "@expand/client-ts"
import { ProjectClient } from "@expand/client-ts/project"

export const connectionHandlers: Pick<Handlers, "Connect" | "Events"> = {
  Connect: () =>
    Stream.unwrap(
      Effect.map(ClientSession, (session) =>
        SubscriptionRef.changes(session.status).pipe(
          Stream.map((status) => status === "connected")
        )
      )
    ),
  Events: (payload) =>
    Stream.unwrap(
      Effect.map(ProjectClient, (client) => client.events(payload).pipe(Stream.orDie))
    )
}

type Handlers = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof ExpandRpcs>>
