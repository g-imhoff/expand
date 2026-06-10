import { Effect, Stream } from "effect"
import type { RpcGroup } from "effect/unstable/rpc"
import { YodeaRpcs } from "@yodea/contracts/rpc"
import { ProjectStore } from "@yodea/client-core"

type Handlers = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof YodeaRpcs>>

export const connectionHandlers: Pick<Handlers, "Connect" | "Events"> = {
  Connect: () => Stream.make(true).pipe(Stream.concat(Stream.never)),
  Events: ({ fromSeq }) =>
    Stream.unwrap(
      Effect.map(ProjectStore, (s) =>
        fromSeq === undefined ? s.events : Stream.filter(s.events, (se) => se.seq > fromSeq)
      )
    )
}
