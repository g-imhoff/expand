import { Effect, Ref, Stream } from "effect"
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
            // Subscribe FIRST so no event can fall between backlog and live.
            const sub = yield* bus.subscribe
            // The last replayed seq can no longer be computed up front (the
            // backlog is streamed, not materialized): track it in a Ref as
            // backlog elements flow. Initialized to fromSeq so an empty backlog
            // degrades to filtering by the cursor itself.
            const lastReplayed = yield* Ref.make(fromSeq)
            const backlog = store.scan({ afterSeq: fromSeq }).pipe(
              Stream.tap((se) => Ref.set(lastReplayed, se.seq)),
              Stream.orDie
            )
            // Stream.concat runs the live side only after the backlog completes,
            // so reading the Ref inside Stream.unwrap sees its final value.
            const live = Stream.unwrap(
              Effect.map(Ref.get(lastReplayed), (last) =>
                Stream.filter(Stream.fromSubscription(sub), (se) => se.seq > last)
              )
            )
            return Stream.concat(backlog, live)
          })
        )
} satisfies Pick<Handlers, "Connect" | "Events">

type Handlers = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof YodeaRpcs>>
