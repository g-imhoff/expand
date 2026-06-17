import { Effect, Stream } from "effect"
import type { RpcGroup } from "effect/unstable/rpc"
import { YodeaRpcs } from "@yodea/contracts/rpc"
import { EventBus } from "@yodea/server/application/event-bus"
import { ConnectionTracker } from "@yodea/server/connection-tracker"
import { EventStore } from "@yodea/server/db/event-store"

export const streamHandlers = {
  Connect: () =>
    Stream.unwrap(
      Effect.gen(function* () {
        const tracker = yield* ConnectionTracker
        yield* tracker.onConnect
        yield* Effect.addFinalizer(() => tracker.onDisconnect)
        return Stream.make(true).pipe(Stream.concat(Stream.never))
      })
    ),
  Events: ({ fromSeq }) =>
    fromSeq === undefined
      ? Stream.unwrap(Effect.map(EventBus, (bus) => bus.stream))
      : Stream.unwrap(
          Effect.gen(function* () {
            const bus = yield* EventBus
            const store = yield* EventStore
            const sub = yield* bus.subscribe
            const backlog = yield* store.readFrom(fromSeq).pipe(Effect.orDie)
            const lastReplayed = backlog.length > 0 ? backlog[backlog.length - 1]!.seq : fromSeq
            return Stream.concat(
              Stream.fromIterable(backlog),
              Stream.filter(Stream.fromSubscription(sub), (se) => se.seq > lastReplayed)
            )
          })
        )
} satisfies Pick<Handlers, "Connect" | "Events">

type Handlers = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof YodeaRpcs>>
