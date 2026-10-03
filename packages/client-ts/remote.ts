import { Cause, Data, Deferred, Effect, Exit, Layer, Option, Redacted, Schedule, Schema, Semaphore, Stream, SubscriptionRef } from "effect"
import type { Scope } from "effect"
import { RpcClient } from "effect/rpc"
import { ExpandRpcs } from "@expand/contracts/rpc"
import { BackendUnavailable } from "./errors"
import type { RuntimeAdapter } from "./adapter"
import { supervised } from "./supervise"
import type { ExpandRpcClientApi } from "./rpc-client"
import { ClientSession } from "./client-session"
import type { ClientSessionApi, ConnectionStatus } from "./client-session"
import { ProjectClientLive } from "./project/client"
import { ServerClientLive } from "./server/client"
import { AutomationClientLive } from "./automation/client"
import { ProjectClient } from "./project/client"
import { ServerClient } from "./server/client"
import { AutomationClient } from "./automation/client"

export class RemoteBackendConfig extends Schema.Opaque<RemoteBackendConfig>()(
  Schema.Struct({
    url: Schema.String,
    token: Schema.RedactedFromValue(Schema.String)
  })
) {}

export interface RemoteEndpoint {
  readonly url: string
  readonly token: Redacted.Redacted<string>
}

export interface RemoteTargetInput {
  readonly host?: string | undefined
  readonly port?: number | undefined
  readonly url?: string | undefined
  readonly secure?: boolean | undefined
  readonly token: string | Redacted.Redacted<string>
}

export interface RemoteConnectionProbe {
  readonly reachable: boolean
  readonly authenticated: boolean
  readonly detail: string
}

export const resolveRemoteEndpoint = Effect.fn("Remote.resolveRemoteEndpoint")(function*(
  input: RemoteTargetInput
): Effect.fn.Return<RemoteEndpoint, BackendUnavailable> {
  const token = typeof input.token === "string" ? Redacted.make(input.token) : input.token
  if (Redacted.value(token).trim().length === 0) {
    return yield* new BackendUnavailable({ reason: "remote backend token is required" })
  }
  const rawUrl = input.url?.trim() ?? ""
  const url = rawUrl.length > 0
    ? yield* parseRemoteUrl(rawUrl)
    : yield* buildRemoteUrl(input.host?.trim() ?? "", input.port, input.secure ?? false)
  return { url, token }
})

export const withoutLocalSpawn = (adapter: RuntimeAdapter): RuntimeAdapter => ({
  protocolLayer: adapter.protocolLayer,
  spawnBackend: () =>
    Effect.fail(new BackendUnavailable({ reason: "remote mode: local backend spawn is disabled" }))
})

export const acquireRemoteClient = Effect.fn("Remote.acquireRemoteClient")((
  adapter: RuntimeAdapter,
  endpoint: RemoteEndpoint
): Effect.Effect<
  { readonly client: ExpandRpcClientApi; readonly endpoint: RemoteEndpoint },
  BackendUnavailable,
  Scope.Scope
> => {
  const guarded = withoutLocalSpawn(adapter)
  const target = endpointWsUrl(endpoint)
  return Effect.gen(function*() {
    const protocol = yield* Layer.build(guarded.protocolLayer(target))
    const client = yield* RpcClient.make(ExpandRpcs).pipe(Effect.provideContext(protocol))
    const ready = yield* Deferred.make<void>()
    yield* Effect.forkScoped(
      supervised(
        "remote-client connect drain",
        Stream.runDrain(
          Stream.tap(client.Connect(), () => Deferred.succeed(ready, undefined))
        )
      )
    )
    yield* Deferred.await(ready).pipe(
      Effect.timeoutOrElse({
        duration: CONNECT_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new RemoteStaleConnection({
              reason: `no presence from ${endpoint.url} within ${CONNECT_TIMEOUT}`
            })
          )
      })
    )
    return { client, endpoint }
  }).pipe(
    Effect.catchCause((cause) => Effect.failCause(Cause.map(cause, (error) => toRemoteUnavailable(error, endpoint))))
  )
})

export const RemoteSessionLayer = (
  adapter: RuntimeAdapter,
  endpoint: RemoteEndpoint
): Layer.Layer<ClientSession, BackendUnavailable> =>
  Layer.effect(ClientSession, makeRemoteSession(adapter, endpoint))

export const RemoteClientLayer = (
  adapter: RuntimeAdapter,
  endpoint: RemoteEndpoint
): Layer.Layer<ClientSession | ProjectClient | ServerClient | AutomationClient, BackendUnavailable> =>
  Layer.mergeAll(ProjectClientLive, ServerClientLive, AutomationClientLive).pipe(
    Layer.provideMerge(RemoteSessionLayer(adapter, endpoint))
  )

export const testRemoteConnection = Effect.fn("Remote.testRemoteConnection")((
  adapter: RuntimeAdapter,
  endpoint: RemoteEndpoint
): Effect.Effect<RemoteConnectionProbe> =>
  Effect.scoped(
    acquireRemoteClient(adapter, endpoint).pipe(
      Effect.flatMap(({ client }) =>
        client.Health().pipe(
          Effect.map((): RemoteConnectionProbe => ({
            reachable: true,
            authenticated: true,
            detail: `connected to ${endpoint.url}`
          })),
          Effect.catch((error) => Effect.succeed(healthProbe(error, endpoint)))
        )
      ),
      Effect.catch((error) => Effect.succeed(acquisitionProbe(error, endpoint)))
    )
  )
)

export const redactTokenText = (
  text: string,
  token: Redacted.Redacted<string>
): string => {
  const raw = Redacted.value(token)
  return raw.length === 0 ? text : text.split(raw).join("[redacted]")
}

const makeRemoteSession = Effect.fn("Remote.makeRemoteSession")(function*(
  adapter: RuntimeAdapter,
  endpoint: RemoteEndpoint
): Effect.fn.Return<
  ClientSessionApi,
  BackendUnavailable,
  Scope.Scope
> {
  const status = yield* SubscriptionRef.make<ConnectionStatus>("disconnected")
  const clients = yield* SubscriptionRef.make<ExpandRpcClientApi | null>(null)
  const ready = yield* Deferred.make<void, BackendUnavailable>()

  const acquireEpoch = Effect.scoped(
    Effect.gen(function*() {
      const hooked = withRemoteConnectionHooks(adapter, clients, status)
      const { client } = yield* acquireRemoteClient(hooked.adapter, endpoint)
      const attempt = hooked.currentAttempt()
      if (attempt === undefined) {
        return yield* new BackendUnavailable({ reason: "connection attempt missing" })
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
        return yield* new BackendUnavailable({ reason: "connection lost" })
      }
      yield* Deferred.await(attempt.disconnected)
      return yield* new BackendUnavailable({ reason: "connection lost" })
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
    Effect.retry(remoteReconnectPolicy)
  )

  yield* Effect.addFinalizer(() =>
    SubscriptionRef.set(clients, null).pipe(
      Effect.andThen(SubscriptionRef.set(status, "disconnected"))
    )
  )
  yield* Effect.forkScoped(supervised("remote-session-connection", loop))
  yield* Deferred.await(ready)

  return {
    status,
    current: currentRemoteClient(clients),
    epochs: SubscriptionRef.changes(clients).pipe(
      Stream.filter((client): client is ExpandRpcClientApi => client !== null)
    )
  }
})

interface RemoteConnectionAttempt {
  readonly disconnected: Deferred.Deferred<void>
  readonly lifecycle: Semaphore.Semaphore
  readonly published: Deferred.Deferred<void>
}

const withRemoteConnectionHooks = (
  adapter: RuntimeAdapter,
  clients: SubscriptionRef.SubscriptionRef<ExpandRpcClientApi | null>,
  status: SubscriptionRef.SubscriptionRef<ConnectionStatus>
): { readonly adapter: RuntimeAdapter; readonly currentAttempt: () => RemoteConnectionAttempt | undefined } => {
  let currentAttempt: RemoteConnectionAttempt | undefined
  return {
    adapter: {
      ...adapter,
      protocolLayer: (url: string) => {
        const attempt: RemoteConnectionAttempt = {
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

const currentRemoteClient = Effect.fn("Remote.currentRemoteClient")(<A>(
  ref: SubscriptionRef.SubscriptionRef<A | null>
): Effect.Effect<A> =>
  SubscriptionRef.changes(ref).pipe(
    Stream.filter((value): value is A => value !== null),
    Stream.runHead,
    Effect.map(Option.getOrThrow)
  )
)

const toUnavailable = (error: { readonly _tag: string }): BackendUnavailable =>
  error._tag === "BackendUnavailable"
    ? (error as BackendUnavailable)
    : new BackendUnavailable({ reason: String(error) })

const toRemoteUnavailable = (
  error: BackendUnavailable | RemoteStaleConnection | unknown,
  endpoint: RemoteEndpoint
): BackendUnavailable => {
  if (error instanceof BackendUnavailable) {
    return new BackendUnavailable({
      reason: redactTokenText(error.reason, endpoint.token),
      cause: error.cause
    })
  }
  if (error instanceof RemoteStaleConnection) {
    return new BackendUnavailable({ reason: redactTokenText(error.reason, endpoint.token) })
  }
  return new BackendUnavailable({
    reason: redactTokenText(`remote backend ${endpoint.url} unavailable: ${String(error)}`, endpoint.token)
  })
}

const healthProbe = (error: unknown, endpoint: RemoteEndpoint): RemoteConnectionProbe => ({
  reachable: true,
  authenticated: false,
  detail: redactTokenText(authDetail(String(error), endpoint.url), endpoint.token)
})

const acquisitionProbe = (error: BackendUnavailable, endpoint: RemoteEndpoint): RemoteConnectionProbe => {
  const reason = redactTokenText(error.reason, endpoint.token)
  return isAuthFailure(reason)
    ? { reachable: true, authenticated: false, detail: `remote ${endpoint.url} is reachable but rejected the token` }
    : { reachable: false, authenticated: false, detail: reason }
}

const authDetail = (message: string, url: string): string =>
  isAuthFailure(message)
    ? `remote ${url} is reachable but rejected the token`
    : `connected to ${url} but health failed: ${message}`

const isAuthFailure = (message: string): boolean =>
  /401|unauthorized|forbidden|auth/i.test(message)

const parseRemoteUrl = (raw: string): Effect.Effect<string, BackendUnavailable> =>
  Effect.suspend(() => {
    let parsed: URL
    try {
      parsed = new URL(raw)
    } catch {
      return Effect.fail(new BackendUnavailable({ reason: "remote URL is not a valid URL" }))
    }
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      return Effect.fail(new BackendUnavailable({ reason: "remote URL must use ws:// or wss://" }))
    }
    if (parsed.username.length > 0 || parsed.password.length > 0) {
      return Effect.fail(new BackendUnavailable({ reason: "remote URL must not embed credentials" }))
    }
    if (parsed.hostname.length === 0) {
      return Effect.fail(new BackendUnavailable({ reason: "remote URL must include a host" }))
    }
    const path = parsed.pathname === "" || parsed.pathname === "/" ? "/rpc" : parsed.pathname
    return Effect.succeed(`${parsed.protocol}//${parsed.host}${path}${parsed.search}`)
  })

const buildRemoteUrl = (
  host: string,
  port: number | undefined,
  secure: boolean
): Effect.Effect<string, BackendUnavailable> => {
  if (host.length === 0) {
    return Effect.fail(new BackendUnavailable({ reason: "remote host is required" }))
  }
  if (port === undefined || !Number.isInteger(port) || port < 1 || port > 65535) {
    return Effect.fail(new BackendUnavailable({ reason: "remote port must be an integer between 1 and 65535" }))
  }
  const needsBrackets = host.includes(":") && !(host.startsWith("[") && host.endsWith("]"))
  const normalizedHost = needsBrackets ? `[${host}]` : host
  return parseRemoteUrl(`${secure ? "wss" : "ws"}://${normalizedHost}:${port}/rpc`)
}

const endpointWsUrl = (endpoint: RemoteEndpoint): string => {
  const secret = Redacted.value(endpoint.token)
  const separator = endpoint.url.includes("?") ? "&" : "?"
  return `${endpoint.url}${separator}token=${encodeURIComponent(secret)}`
}

class RemoteStaleConnection extends Data.TaggedError("RemoteStaleConnection")<{
  readonly reason: string
}> {}

const CONNECT_TIMEOUT = "3 seconds" as const

const remoteReconnectPolicy = Schedule.min([
  Schedule.exponential("500 millis", 1.5),
  Schedule.spaced("5 seconds")
])
