import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Schedule,
  Scope,
  Stream,
  SubscriptionRef
} from "effect"
import { RpcClient } from "effect/unstable/rpc"
import type { RuntimeAdapter } from "./adapter"
import { BackendUnavailable } from "./errors"
import { acquireClient, type ExpandRpcClientApi } from "./rpc-client"
import { supervised } from "./supervise"

export interface ClientSessionApi {
  readonly status: SubscriptionRef.SubscriptionRef<ConnectionStatus>
  readonly current: Effect.Effect<ExpandRpcClientApi>
  readonly epochs: Stream.Stream<ExpandRpcClientApi>
}

export class ClientSession extends Context.Service<ClientSession, ClientSessionApi>()(
  "expand/ClientSession"
) {}

export type ConnectionStatus = "connected" | "reconnecting" | "disconnected"

export const ClientSessionLayer = (
  adapter: RuntimeAdapter
): Layer.Layer<ClientSession, BackendUnavailable, FileSystem.FileSystem> =>
  Layer.effect(ClientSession, makeSession(adapter))

const reconnectPolicy = Schedule.exponential("500 millis", 1.5).pipe(
  Schedule.either(Schedule.spaced("5 seconds"))
)

const withConnectionHooks = (
  adapter: RuntimeAdapter,
  clients: SubscriptionRef.SubscriptionRef<ExpandRpcClientApi | null>,
  status: SubscriptionRef.SubscriptionRef<ConnectionStatus>,
  disconnected: Deferred.Deferred<void>
): RuntimeAdapter => ({
  ...adapter,
  protocolLayer: (url: string) =>
    adapter.protocolLayer(url).pipe(
      Layer.provide(
        Layer.succeed(RpcClient.ConnectionHooks, {
          onConnect: Effect.void,
          onDisconnect: Deferred.isDone(disconnected).pipe(
            Effect.flatMap((done) =>
              done
                ? Effect.void
                : SubscriptionRef.set(clients, null).pipe(
                    Effect.andThen(SubscriptionRef.set(status, "reconnecting")),
                    Effect.andThen(Deferred.succeed(disconnected, undefined)),
                    Effect.asVoid
                  )
            )
          )
        })
      )
    )
})

const toUnavailable = (error: { readonly _tag: string }): BackendUnavailable =>
  error._tag === "BackendUnavailable"
    ? (error as BackendUnavailable)
    : new BackendUnavailable({ reason: String(error) })

const currentClient = <A>(
  ref: SubscriptionRef.SubscriptionRef<A | null>
): Effect.Effect<A> =>
  SubscriptionRef.changes(ref).pipe(
    Stream.filter((value): value is A => value !== null),
    Stream.runHead,
    Effect.map(Option.getOrThrow)
  )

const makeSession = (
  adapter: RuntimeAdapter
): Effect.Effect<ClientSessionApi, BackendUnavailable, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const status = yield* SubscriptionRef.make<ConnectionStatus>("disconnected")
    const clients = yield* SubscriptionRef.make<ExpandRpcClientApi | null>(null)
    const ready = yield* Deferred.make<void, BackendUnavailable>()

    const acquireEpoch = Effect.scoped(
      Effect.gen(function* () {
        const disconnected = yield* Deferred.make<void>()
        const hooked = withConnectionHooks(adapter, clients, status, disconnected)
        const { client } = yield* acquireClient(hooked)
        yield* SubscriptionRef.set(clients, client)
        yield* SubscriptionRef.set(status, "connected")
        yield* Deferred.succeed(ready, undefined)
        yield* Deferred.await(disconnected)
        return yield* Effect.fail(new BackendUnavailable({ reason: "connection lost" }))
      })
    )

    const loop = acquireEpoch.pipe(
      Effect.tapError((error) => Deferred.fail(ready, toUnavailable(error))),
      Effect.exit,
      Effect.flatMap((exit) =>
        Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
          ? Effect.failCause(exit.cause)
          : Effect.fail(new BackendUnavailable({ reason: "connection lost" }))
      ),
      Effect.retry(reconnectPolicy)
    )

    yield* Effect.addFinalizer(() =>
      SubscriptionRef.set(clients, null).pipe(
        Effect.andThen(SubscriptionRef.set(status, "disconnected"))
      )
    )
    yield* Effect.forkScoped(supervised("client-session-connection", loop))
    yield* Deferred.await(ready)

    return {
      status,
      current: currentClient(clients),
      epochs: SubscriptionRef.changes(clients).pipe(
        Stream.filter((client): client is ExpandRpcClientApi => client !== null)
      )
    }
  })
