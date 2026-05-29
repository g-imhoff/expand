import { Effect, Stream } from "effect"
import { YodeaRpcs } from "@yodea/shared/rpc"
import { UseCases } from "@yodea/application/use-cases"
import { EventBus } from "@yodea/application/event-bus"
import { ConnectionTracker } from "@yodea/server/connection-tracker"

export const YodeaHandlers = YodeaRpcs.toLayer({
  Health: () => Effect.flatMap(UseCases, (u) => u.health),
  // The contract declares no client-facing error for these procedures: a SQL or
  // codec failure is a server defect, not a typed RPC error. `Effect.orDie`
  // discharges the use-case error channel (SqlError | SchemaError) to match the
  // contract's `Schema.Never` error schema.
  ProjectCreate: ({ name }) =>
    Effect.flatMap(UseCases, (u) => u.createProject(name)).pipe(Effect.orDie),
  ProjectList: () => Effect.flatMap(UseCases, (u) => u.listProjects).pipe(Effect.orDie),
  // Presence channel = the I-4 connection. onConnect when the subscription is
  // established; emit one `true` so the client can confirm before doing work;
  // onDisconnect (via finalizer) when the stream's scope closes on socket drop.
  // `Stream.never` keeps the subscription open after the marker. In v4 the
  // wrapped effect requires Scope, and `Stream.unwrap` discharges it.
  Connect: () =>
    Stream.unwrap(
      Effect.gen(function* () {
        const tracker = yield* ConnectionTracker
        yield* tracker.onConnect
        yield* Effect.addFinalizer(() => tracker.onDisconnect)
        return Stream.make(true).pipe(Stream.concat(Stream.never))
      })
    ),
  // Live domain-event stream (read-model frontends). No presence side effects.
  Events: () => Stream.unwrap(Effect.map(EventBus, (bus) => bus.stream))
})
