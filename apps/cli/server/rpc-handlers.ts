import { Effect, Stream } from "effect"
import { YodeaRpcs, ProjectAlreadyExists } from "@yodea/contracts/rpc"
import { UseCases } from "@yodea/application/use-cases"
import { EventBus } from "@yodea/application/event-bus"
import { ConnectionTracker } from "@yodea/server/connection-tracker"

export const YodeaHandlers = YodeaRpcs.toLayer({
  Health: () => Effect.flatMap(UseCases, (u) => u.health),
  // Pass `ensure`; propagate the typed ProjectAlreadyExists to the RPC error
  // channel, but die on infrastructural failures (SqlError/SchemaError) — those
  // are server defects, not client-facing errors (matches the contract).
  //
  // The first arg is a Refinement keyed on the ProjectAlreadyExists `_tag`, so
  // `catchIf` narrows the residual error channel: the matched branch re-fails it
  // (keeping it typed), and the `orElse` branch dies on everything else
  // (Exclude<E, ProjectAlreadyExists> = SqlError | SchemaError). The resulting
  // error channel is exactly ProjectAlreadyExists, matching the RPC contract.
  ProjectCreate: ({ name, ensure }) =>
    Effect.flatMap(UseCases, (u) => u.createProject(name, ensure)).pipe(
      Effect.catchIf(
        (e): e is ProjectAlreadyExists =>
          typeof e === "object" && e !== null && "_tag" in e &&
          (e as { _tag: string })._tag === "ProjectAlreadyExists",
        (e) => Effect.fail(e),
        (e) => Effect.die(e)
      )
    ),
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
