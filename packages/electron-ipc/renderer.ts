import { Cause, Data, Effect, Queue, Schema, Stream } from "effect"
import type { IpcContract } from "./contract"
import type { AnyChannel, Bridge, InvokeChannel, SendChannel, EventChannel, PortExchangeChannel } from "./internal/contract"
import { isStrictResult, wire } from "./internal/contract"

export class IpcTransportError extends Data.TaggedError("IpcTransportError")<{ readonly reason: "bridge-missing" | "transport" | "decode" | "timeout"; readonly message: string }> {}
export type IpcClientOf<C extends IpcContract> = { readonly [K in keyof C["channels"] & string]: C["channels"][K] extends InvokeChannel<infer P, infer S, infer E> ? (payload: P["Type"]) => Effect.Effect<S["Type"], E["Type"] | IpcTransportError> : C["channels"][K] extends SendChannel<infer P> ? (payload: P["Type"]) => Effect.Effect<void, IpcTransportError> : C["channels"][K] extends EventChannel<infer P> ? Stream.Stream<P["Type"], IpcTransportError> : C["channels"][K] extends PortExchangeChannel ? Effect.Effect<MessagePort, IpcTransportError> : never }

export const makeElectronIpcClient = <C extends IpcContract>(contract: C, options: { readonly timeoutMillis?: number } = {}): IpcClientOf<C> => {
  const timeout = options.timeoutMillis ?? 10_000
  if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error("timeoutMillis must be a positive safe integer")
  const globalWindow = (globalThis as { readonly window?: Window }).window
  const bridge = globalWindow?.[contract.prefix as keyof Window] as Bridge<C> | undefined
  const client: Record<string, unknown> = {}
  const encode = (schema: Schema.Top, payload: unknown, key: string) => Schema.encodeUnknownEffect(codec(schema))(payload).pipe(Effect.mapError((e: unknown) => fail("decode", `encode failed (${key}): ${String(e)}`)))
  const decode = (schema: Schema.Top, payload: unknown, key: string) => Schema.decodeUnknownEffect(codec(schema))(payload).pipe(Effect.mapError((e: unknown) => fail("decode", `decode failed (${key}): ${String(e)}`)))
  for (const [key, channel] of Object.entries<AnyChannel>(contract.channels)) {
    const fn = bridge && (bridge as unknown as Record<string, unknown>)[key]
    const missing = () => Effect.fail(fail("bridge-missing", `bridge function "${key}" missing`))
    if (channel._kind === "send") client[key] = (payload: unknown) => typeof fn !== "function" ? missing() : encode(channel.payload, payload, key).pipe(Effect.flatMap((value) => Effect.try({ try: () => fn(value), catch: (e) => fail("transport", String(e)) })))
    else if (channel._kind === "invoke") client[key] = (payload: unknown) => typeof fn !== "function" ? missing() : encode(channel.payload, payload, key).pipe(Effect.flatMap((value) => Effect.tryPromise({ try: () => fn(value), catch: (e) => fail("transport", String(e)) })), Effect.flatMap((envelope: unknown) => {
      if (!isStrictResult(envelope)) return Effect.fail(fail("decode", "malformed result envelope"))
      if (envelope._tag === "IpcSuccess") return decode(channel.success, envelope.value, key)
      if (envelope._tag === "IpcFailure") return decode(channel.error, envelope.error, key).pipe(Effect.flatMap((e) => Effect.fail(e)))
      return Effect.fail(fail("decode", envelope.message))
    }))
    else if (channel._kind === "event") client[key] = Stream.callback<unknown, IpcTransportError>((queue) => {
      if (typeof fn !== "function") return Effect.fail(fail("bridge-missing", `bridge function "${key}" missing`))
      let active = true
      let removed = false
      let unsubscribe: (() => void) | undefined
      let pendingMalformed: IpcTransportError | undefined
      const remove = () => {
        if (removed || unsubscribe === undefined) return
        removed = true
        unsubscribe()
      }
      const terminateMalformed = (decodeError: IpcTransportError) => {
        if (unsubscribe === undefined) {
          pendingMalformed = decodeError
          return
        }
        try { remove() } catch (error) {
          Queue.failCauseUnsafe(queue, Cause.combine(
            Cause.fail(decodeError),
            Cause.fail(fail("transport", `event cleanup failed (${key}): ${String(error)}`))
          ))
          return
        }
        Queue.failCauseUnsafe(queue, Cause.fail(decodeError))
      }
      const listener = (payload: unknown) => {
        if (!active) return
        const decoded = Schema.decodeUnknownOption(codec(channel.payload))(payload)
        if (decoded._tag === "Some") Queue.offerUnsafe(queue, decoded.value)
        else {
          active = false
          terminateMalformed(fail("decode", `malformed event payload (${key})`))
        }
      }
      const acquired = Effect.try({
        try: () => {
          const dispose = fn(listener) as () => void
          unsubscribe = dispose
          if (pendingMalformed !== undefined) {
            const decodeError = pendingMalformed
            pendingMalformed = undefined
            terminateMalformed(decodeError)
          } else if (!active) remove()
          return dispose
        },
        catch: (e) => fail("transport", String(e))
      })
      return Effect.acquireRelease(acquired, () => Effect.sync(() => { active = false; remove() }))
    })
    else client[key] = Effect.suspend(() => {
      if (typeof fn !== "function") return missing()
      const windowRef = globalWindow
      if (!windowRef) return missing()
      return Effect.scoped(Effect.gen(function* () {
        const nonceBytes = new Uint8Array(16)
        yield* Effect.try({ try: () => globalThis.crypto.getRandomValues(nonceBytes), catch: (e) => fail("transport", `nonce generation failed: ${String(e)}`) })
        const nonce = Array.from(nonceBytes, (n) => n.toString(16).padStart(2, "0")).join("")
        const queue = yield* Effect.acquireRelease(Queue.unbounded<MessagePort>(), Queue.shutdown)
        const listener = (event: MessageEvent) => { if (event.source !== windowRef || !isGrant(event.data) || event.data.channel !== wire(contract, key) || event.data.nonce !== nonce) return; const port = event.ports[0]; if (port) Queue.offerUnsafe(queue, port) }
        yield* Effect.acquireRelease(Effect.try({ try: () => { windowRef.addEventListener("message", listener) }, catch: (e) => fail("transport", `message listener acquisition failed: ${String(e)}`) }), () => Effect.sync(() => windowRef.removeEventListener("message", listener)))
        yield* Effect.try({ try: () => fn(nonce), catch: (e) => fail("transport", String(e)) })
        return yield* Effect.timeoutOrElse(Queue.take(queue), { duration: `${timeout} millis`, orElse: () => Effect.fail(fail("timeout", `no port grant within ${timeout}ms`)) })
      }))
    })
  }
  return client as IpcClientOf<C>
}
const isGrant = (value: unknown): value is { _tag: "IpcPortGrant"; channel: string; nonce: string } => {
  if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype) return false
  const keys = Reflect.ownKeys(value)
  if (keys.length !== 3 || !keys.includes("_tag") || !keys.includes("channel") || !keys.includes("nonce")) return false
  const tag = Object.getOwnPropertyDescriptor(value, "_tag")
  const channel = Object.getOwnPropertyDescriptor(value, "channel")
  const nonce = Object.getOwnPropertyDescriptor(value, "nonce")
  return tag !== undefined && "value" in tag && tag.value === "IpcPortGrant" &&
    channel !== undefined && "value" in channel && typeof channel.value === "string" &&
    nonce !== undefined && "value" in nonce && typeof nonce.value === "string"
}
const codec = (schema: Schema.Top): Schema.Encoder<unknown, never> & Schema.Decoder<unknown, never> => schema as unknown as Schema.Encoder<unknown, never> & Schema.Decoder<unknown, never>
const fail = (reason: IpcTransportError["reason"], message: string) => new IpcTransportError({ reason, message })
