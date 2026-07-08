import { Effect, Stream, SubscriptionRef } from "effect"
import type { RpcGroup } from "effect/unstable/rpc"
import { ExpandRpcs } from "@expand/contracts/rpc"
import { ProjectStore } from "@expand/client-core"

export const connectionHandlers: Pick<Handlers, "Connect" | "Events"> = {
  Connect: () =>
    Stream.unwrap(
      Effect.map(ProjectStore, (s) =>
        Stream.map(SubscriptionRef.changes(s.status), (status) => status === "connected")
      )
    ),
  Events: ({ fromSeq }) =>
    Stream.unwrap(
      Effect.map(ProjectStore, (s) =>
        fromSeq === undefined ? s.events : Stream.filter(s.events, (se) => se.seq > fromSeq)
      )
    )
}

type Handlers = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof ExpandRpcs>>
