// Renderer interpreter: Effect-based typed client over the preload bridge.
// Encodes outbound payloads, decodes everything inbound (decode-for-fidelity:
// structured clone flattens branded types/Dates). MUST NOT import "electron".
import { Data, Effect, Queue, Schema, Stream } from "effect"
import type {
  AnyIpcChannel,
  EventChannel,
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
  const timeoutMillis = options.timeoutMillis ?? DEFAULT_TIMEOUT_MILLIS
  const makeNonce = options.nonce ?? (() => crypto.randomUUID())

  const bridgeFn = (key: string): Effect.Effect<(...args: Array<unknown>) => unknown, IpcTransportError> =>
    Effect.suspend(() => {
      const bridge = options.bridge()
      const fn =
        typeof bridge === "object" && bridge !== null ? (bridge as Record<string, unknown>)[key] : undefined
      return typeof fn === "function"
        ? Effect.succeed(fn as (...args: Array<unknown>) => unknown)
        : Effect.fail(new IpcTransportError({ reason: "bridge-missing", message: `bridge function "${key}" missing` }))
    })

  // Boundary codecs operate on generic `Schema.Top` fields. The sync/effect
  // codec helpers constrain to `Schema.Codec<unknown>` (service-free RD/RE = never),
  // which `Schema.Top` (RD/RE = unknown) does not satisfy structurally. IPC payloads
  // are wire-shaped and carry no service requirements, so we narrow each field to a
  // service-free codec at the call site.
  const codec = (schema: Schema.Top): Schema.Codec<unknown, unknown> =>
    schema as unknown as Schema.Codec<unknown, unknown>

  const client: Record<string, unknown> = {}

  for (const [key, channel] of Object.entries<AnyIpcChannel>(contract.channels)) {
    const wire = wireName(contract, key as keyof C["channels"] & string)

    switch (channel._kind) {
      case "send": {
        client[key] = (payload: unknown) =>
          Effect.flatMap(bridgeFn(key), (fn) =>
            Effect.try({
              try: () => Schema.encodeUnknownSync(codec(channel.payload))(payload),
              catch: (error) => new IpcTransportError({ reason: "decode", message: `encode failed (${key}): ${error}` })
            }).pipe(
              Effect.flatMap((encoded) =>
                Effect.try({
                  try: () => {
                    fn(encoded)
                  },
                  catch: (error) =>
                    new IpcTransportError({ reason: "transport", message: `bridge call failed (${key}): ${error}` })
                })
              )
            )
          )
        break
      }

      case "invoke": {
        const routeEnvelope = (envelope: unknown): Effect.Effect<unknown, unknown> => {
          if (!isResultEnvelope(envelope)) {
            return Effect.fail(new IpcTransportError({ reason: "decode", message: "malformed result envelope" }))
          }
          switch (envelope._tag) {
            case "IpcSuccess":
              return Schema.decodeUnknownEffect(codec(channel.success))(envelope.value).pipe(
                Effect.mapError(
                  (error) => new IpcTransportError({ reason: "decode", message: `decode failed (${key}): ${error}` })
                )
              )
            case "IpcFailure":
              return Schema.decodeUnknownEffect(codec(channel.error))(envelope.error).pipe(
                Effect.mapError(
                  (error) => new IpcTransportError({ reason: "decode", message: `decode failed (${key}): ${error}` })
                ),
                Effect.flatMap((domainError) => Effect.fail(domainError))
              )
            case "IpcDefect":
              return Effect.die(new Error(`ipc handler defect: ${envelope.message}`))
          }
        }
        client[key] = (payload: unknown) =>
          Effect.flatMap(bridgeFn(key), (fn) =>
            Effect.try({
              try: () => Schema.encodeUnknownSync(codec(channel.payload))(payload),
              catch: (error) => new IpcTransportError({ reason: "decode", message: `encode failed (${key}): ${error}` })
            }).pipe(
              Effect.flatMap((encoded) =>
                Effect.tryPromise({
                  try: () => Promise.resolve(fn(encoded)),
                  catch: (error) => new IpcTransportError({ reason: "transport", message: String(error) })
                })
              ),
              Effect.flatMap(routeEnvelope)
            )
          )
        break
      }

      case "event": {
        // Backpressure stance: Stream.callback's default queue is unbounded. This is
        // deliberate while no high-frequency event channels exist — buffering everything
        // keeps the path simple and lossless. Revisit with an explicit bufferSize/strategy
        // (e.g. dropping or sliding) when a chatty channel appears.
        client[key] = Stream.callback<unknown, IpcTransportError>((queue) =>
          Effect.acquireRelease(
            Effect.flatMap(bridgeFn(key), (subscribe) =>
              Effect.sync(() =>
                (subscribe as (listener: (payload: unknown) => void) => () => void)((encodedPayload) => {
                  try {
                    Queue.offerUnsafe(queue, Schema.decodeUnknownSync(codec(channel.payload))(encodedPayload))
                  } catch {
                    // decode failure: drop the event, stream stays alive (spec §9)
                  }
                })
              )
            ),
            (unsubscribe) => Effect.sync(unsubscribe)
          )
        )
        break
      }

      case "portExchange": {
        client[key] = Effect.flatMap(bridgeFn(key), (request) =>
          Effect.callback<MessagePort, IpcTransportError>((resume) => {
            const nonce = makeNonce()
            const onMessage = (event: MessageEventLike) => {
              if (event.source !== options.win) return
              if (!isPortGrantMessage(event.data)) return
              if (event.data.channel !== wire || event.data.nonce !== nonce) return
              const port = event.ports[0]
              if (port === undefined) return
              options.win.removeEventListener("message", onMessage)
              resume(Effect.succeed(port))
            }
            options.win.addEventListener("message", onMessage)
            try {
              request(nonce)
            } catch (error) {
              // The bridge call threw before any grant could arrive — unregister the
              // listener we just added (otherwise it leaks) and surface a transport error.
              options.win.removeEventListener("message", onMessage)
              resume(Effect.fail(new IpcTransportError({ reason: "transport", message: String(error) })))
            }
            return Effect.sync(() => options.win.removeEventListener("message", onMessage))
          }).pipe(
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

const DEFAULT_TIMEOUT_MILLIS = 10_000
