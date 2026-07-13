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
  Semaphore,
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

interface ConnectionAttempt {
  readonly disconnected: Deferred.Deferred<void>
  readonly lifecycle: Semaphore.Semaphore
  readonly published: Deferred.Deferred<void>
}

const withConnectionHooks = (
  adapter: RuntimeAdapter,
  clients: SubscriptionRef.SubscriptionRef<ExpandRpcClientApi | null>,
  status: SubscriptionRef.SubscriptionRef<ConnectionStatus>
): { readonly adapter: RuntimeAdapter; readonly currentAttempt: () => ConnectionAttempt | undefined } => {
  let currentAttempt: ConnectionAttempt | undefined
  return {
    adapter: {
      ...adapter,
      protocolLayer: (url: string) => {
        const attempt: ConnectionAttempt = {
          disconnected: Deferred.makeUnsafe<void>(),
          lifecycle: Semaphore.makeUnsafe(1),
          published: Deferred.makeUnsafe<void>()
        }
        currentAttempt = attempt
        return adapter.protocolLayer(url).pipe(
          Layer.provide(
            Layer.succeed(RpcClient.ConnectionHooks, {
              onConnect: Effect.void,
              onDisconnect: attempt.lifecycle.withPermit(
                Deferred.isDone(attempt.disconnected).pipe(
                  Effect.flatMap((done) =>
                    done
                      ? Effect.void
                      : Deferred.isDone(attempt.published).pipe(
                          Effect.flatMap((published) =>
                            (published
                              ? SubscriptionRef.set(clients, null).pipe(
                                  Effect.andThen(SubscriptionRef.set(status, "reconnecting"))
                                )
                              : Effect.void
                            ).pipe(
                              Effect.andThen(Deferred.succeed(attempt.disconnected, undefined)),
                              Effect.asVoid
                            )
                          )
                        )
                  )
                )
              )
            })
          )
        )
      }
    },
    currentAttempt: () => currentAttempt
  }
}

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
        const hooked = withConnectionHooks(adapter, clients, status)
        const { client } = yield* acquireClient(hooked.adapter)
        const attempt = hooked.currentAttempt()
        if (attempt === undefined) {
          return yield* Effect.fail(new BackendUnavailable({ reason: "connection attempt missing" }))
        }
        const published = yield* attempt.lifecycle.withPermit(
          Deferred.isDone(attempt.disconnected).pipe(
            Effect.flatMap((done) =>
              done
                ? Effect.succeed(false)
                : Deferred.succeed(attempt.published, undefined).pipe(
                    Effect.andThen(SubscriptionRef.set(clients, client)),
                    Effect.andThen(SubscriptionRef.set(status, "connected")),
                    Effect.andThen(Deferred.succeed(ready, undefined)),
                    Effect.as(true)
                  )
            )
          )
        )
        if (!published) {
          return yield* Effect.fail(new BackendUnavailable({ reason: "connection lost" }))
        }
        yield* Deferred.await(attempt.disconnected)
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
