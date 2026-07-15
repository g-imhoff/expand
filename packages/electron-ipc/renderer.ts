// Renderer interpreter: Effect-based typed client over the preload bridge.
// Encodes outbound payloads, decodes everything inbound (decode-for-fidelity:
// structured clone flattens branded types/Dates). MUST NOT import "electron".
import { Data, Effect, Option, Queue, Schema, Stream } from "effect"
import type {
  AnyIpcChannel,
  EventChannel,
  IpcBridgeOf,
  InvokeChannel,
  IpcContract,
  PortExchangeChannel,
  SendChannel
} from "@expand/electron-ipc/contract"
import { isPortGrantMessage, isResultEnvelope, wireName } from "@expand/electron-ipc/contract"

export class IpcTransportError extends Data.TaggedError("IpcTransportError")<{
  readonly reason: "bridge-missing" | "transport" | "decode" | "timeout"
  readonly message: string
}> {}

export interface MessageEventLike {
  readonly data: unknown
  readonly source: unknown
  readonly ports: ReadonlyArray<MessagePort>
}

export interface RendererWindowLike {
  readonly addEventListener: (type: "message", listener: (event: MessageEventLike) => void) => void
  readonly removeEventListener: (type: "message", listener: (event: MessageEventLike) => void) => void
}

export interface MakeIpcClientOptions {
  /** Lazy accessor: the bridge may not exist if the preload failed (→ bridge-missing). */
  readonly bridge: () => unknown
  /** The window object — used both to listen for port grants and as the trusted event.source identity. */
  readonly win: RendererWindowLike
  readonly nonce?: () => string
  readonly timeoutMillis?: number
}

export type IpcClientOf<C extends IpcContract> = {
  readonly [K in keyof C["channels"] & string]: C["channels"][K] extends InvokeChannel<infer P, infer S, infer E>
    ? (payload: P["Type"]) => Effect.Effect<S["Type"], E["Type"] | IpcTransportError>
    : C["channels"][K] extends SendChannel<infer P>
      ? (payload: P["Type"]) => Effect.Effect<void, IpcTransportError>
      : C["channels"][K] extends EventChannel<infer P>
        ? Stream.Stream<P["Type"], IpcTransportError>
        : C["channels"][K] extends PortExchangeChannel
          ? Effect.Effect<MessagePort, IpcTransportError>
          : never
}

export const makeIpcClient = <C extends IpcContract>(contract: C, options: MakeIpcClientOptions): IpcClientOf<C> => {
  type InvokeBridgeMember = IpcBridgeOf<IpcContract<string, { readonly invoke: InvokeChannel }>>["invoke"]
  type SendBridgeMember = (payload: unknown) => void
  type EventBridgeMember = (listener: (payload: unknown) => void) => () => void
  type PortBridgeMember = (nonce: string) => void

  const timeoutMillis = options.timeoutMillis ?? 10_000
  const makeNonce = options.nonce ?? (() => crypto.randomUUID.call(crypto))

  const codec = (schema: Schema.Top): Schema.Codec<unknown, unknown> =>
    schema as unknown as Schema.Codec<unknown, unknown>

  const bridgeFn = Effect.fn("ElectronIpcRenderer.bridge")(<A>(key: string): Effect.Effect<A, IpcTransportError> =>
    Effect.suspend(() => {
      const bridge = options.bridge()
      const fn = typeof bridge === "object" && bridge !== null
        ? (bridge as Record<string, unknown>)[key]
        : undefined
      return typeof fn === "function"
        ? Effect.succeed(fn as A)
        : Effect.fail(new IpcTransportError({ reason: "bridge-missing", message: `bridge function "${key}" missing` }))
    }))

  const encodePayload = Effect.fn("ElectronIpcRenderer.encode")((key: string, schema: Schema.Top, payload: unknown) =>
    Schema.encodeUnknownEffect(codec(schema))(payload).pipe(
      Effect.mapError(
        (error) => new IpcTransportError({ reason: "decode", message: `encode failed (${key}): ${error}` })
      )
    ))

  const decodePayload = Effect.fn("ElectronIpcRenderer.decode")((key: string, schema: Schema.Top, payload: unknown) =>
    Schema.decodeUnknownEffect(codec(schema))(payload).pipe(
      Effect.mapError(
        (error) => new IpcTransportError({ reason: "decode", message: `decode failed (${key}): ${error}` })
      )
    ))

  const routeEnvelope = Effect.fn("ElectronIpcRenderer.routeEnvelope")((
    key: string,
    success: Schema.Top,
    failure: Schema.Top,
    envelope: unknown
  ): Effect.Effect<unknown, unknown> => {
    if (!isResultEnvelope(envelope)) {
      return Effect.fail(new IpcTransportError({ reason: "decode", message: "malformed result envelope" }))
    }
    switch (envelope._tag) {
      case "IpcSuccess":
        return decodePayload(key, success, envelope.value)
      case "IpcFailure":
        return decodePayload(key, failure, envelope.error).pipe(
          Effect.flatMap((domainError) => Effect.fail(domainError))
        )
      case "IpcDefect":
        return Effect.die(new Error(`ipc handler defect: ${envelope.message}`))
    }
  })

  const acquireNonce = Effect.fn("ElectronIpcRenderer.acquireNonce")(() =>
    Effect.try({
      try: makeNonce,
      catch: (error) => new IpcTransportError({ reason: "transport", message: `nonce acquisition failed: ${error}` })
    }))

  const client: Record<string, unknown> = {}

  for (const [key, channel] of Object.entries<AnyIpcChannel>(contract.channels)) {
    const wire = wireName(contract, key as keyof C["channels"] & string)

    switch (channel._kind) {
      case "send": {
        client[key] = (payload: unknown) =>
          Effect.flatMap(bridgeFn<SendBridgeMember>(key), (send) =>
            encodePayload(key, channel.payload, payload).pipe(
              Effect.flatMap((encoded) =>
                Effect.try({
                  try: () => send(encoded),
                  catch: (error) =>
                    new IpcTransportError({ reason: "transport", message: `bridge call failed (${key}): ${error}` })
                })
              )
            )
          )
        break
      }

      case "invoke": {
        client[key] = (payload: unknown) =>
          Effect.flatMap(bridgeFn<InvokeBridgeMember>(key), (invoke) =>
            encodePayload(key, channel.payload, payload).pipe(
              Effect.flatMap((encoded) =>
                Effect.tryPromise(() => invoke(encoded)).pipe(
                  Effect.mapError(
                    (error) => new IpcTransportError({ reason: "transport", message: String(error.cause) })
                  )
                )
              ),
              Effect.flatMap((envelope) => routeEnvelope(key, channel.success, channel.error, envelope))
            )
          )
        break
      }

      case "event": {
        client[key] = Stream.callback<unknown, IpcTransportError>((queue) =>
          Effect.flatMap(bridgeFn<EventBridgeMember>(key), (subscribe) =>
            Effect.acquireRelease(
              Effect.try({
                try: () => {
                  const state = { active: true }
                  const listener = (encodedPayload: unknown) => {
                    if (!state.active) return
                    const decoded = Schema.decodeUnknownOption(codec(channel.payload))(encodedPayload)
                    if (Option.isSome(decoded)) Queue.offerUnsafe(queue, decoded.value)
                  }
                  return { state, unsubscribe: subscribe(listener) }
                },
                catch: (error) =>
                  new IpcTransportError({ reason: "transport", message: `bridge call failed (${key}): ${error}` })
              }),
              ({ state, unsubscribe }) =>
                Effect.sync(() => {
                  state.active = false
                  unsubscribe()
                })
            )
          ).pipe(Effect.catchCause((cause) => Queue.failCause(queue, cause)))
        )
        break
      }

      case "portExchange": {
        client[key] = Effect.flatMap(bridgeFn<PortBridgeMember>(key), (request) =>
          Effect.scoped(
            Effect.gen(function* () {
              const nonce = yield* acquireNonce()
              const queue = yield* Effect.acquireRelease(
                Queue.make<MessagePort>(),
                Queue.shutdown
              )
              const state = { active: true }
              const listener = (event: MessageEventLike) => {
                if (!state.active) return
                if (event.source !== options.win) return
                if (!isPortGrantMessage(event.data)) return
                if (event.data.channel !== wire || event.data.nonce !== nonce) return
                const port = event.ports[0]
                if (port !== undefined) Queue.offerUnsafe(queue, port)
              }
              yield* Effect.acquireRelease(
                Effect.try({
                  try: () => {
                    options.win.addEventListener("message", listener)
                    return listener
                  },
                  catch: (error) =>
                    new IpcTransportError({ reason: "transport", message: `listener acquisition failed: ${error}` })
                }),
                (exactListener) =>
                  Effect.sync(() => {
                    state.active = false
                    options.win.removeEventListener("message", exactListener)
                  })
              )
              yield* Effect.try({
                try: () => request(nonce),
                catch: (error) => new IpcTransportError({ reason: "transport", message: String(error) })
              })
              return yield* Queue.take(queue)
            })
          ).pipe(
            Effect.timeoutOrElse({
              duration: `${timeoutMillis} millis`,
              orElse: () =>
                Effect.fail(
                  new IpcTransportError({ reason: "timeout", message: `no port grant within ${timeoutMillis}ms` })
                )
            })
          )
        )
        break
      }
    }
  }

  return client as IpcClientOf<C>
}
