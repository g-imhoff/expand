import { Cause, Effect, Exit, FiberSet, Schema } from "effect"
import type { Scope } from "effect"
import type {
  AnyIpcChannel,
  EventChannel,
  IpcContract,
  IpcEmitterOf,
  IpcHandlersOf,
  IpcSenderInfo,
  ResultEnvelope
} from "@expand/electron-ipc/contract"
import { portGrantName, portRequestName, wireName } from "@expand/electron-ipc/contract"

export interface FrameLike {
  readonly url: string
  readonly detached: boolean
}

export interface IpcMainEventLike {
  readonly sender: unknown
  readonly senderFrame: FrameLike | null
}

export interface WindowTargetLike<Port = unknown> {
  readonly webContents: unknown
  readonly mainFrame: FrameLike | null
  readonly postToRenderer: (channel: string, payload: unknown, transfer: ReadonlyArray<Port>) => void
}

export interface FrameSnapshot {
  readonly url: string | null
  readonly isMainFrame: boolean
}

export interface IpcMainLike {
  readonly on: (channel: string, listener: (event: IpcMainEventLike, payload: unknown) => void) => () => void
  readonly handle: (
    channel: string,
    handler: (event: IpcMainEventLike, payload: unknown) => Promise<unknown>
  ) => () => void
}

export interface BindIpcConfig<R, Port = unknown> {
  readonly ipc: IpcMainLike
  readonly target: WindowTargetLike<Port>
  readonly originRules: ReadonlyArray<OriginRule>
  readonly maxPayloadBytes?: number
  readonly log?: (message: string, cause: Cause.Cause<unknown> | undefined) => Effect.Effect<void, never, R>
}

export type OriginRule =
  | { readonly _tag: "exactOrigin"; readonly origin: string }
  | { readonly _tag: "exactUrl"; readonly url: string }
  | { readonly _tag: "fileProtocol" }

export const snapshotSender = (
  event: IpcMainEventLike,
  target: Pick<WindowTargetLike, "webContents" | "mainFrame">
): FrameSnapshot => {
  if (event.sender !== target.webContents) return { url: null, isMainFrame: false }
  const frame = event.senderFrame
  if (frame === null || frame.detached) return { url: null, isMainFrame: false }
  return { url: frame.url, isMainFrame: target.mainFrame !== null && frame === target.mainFrame }
}

export const validateSender = (snapshot: FrameSnapshot, rules: ReadonlyArray<OriginRule>): boolean => {
  if (snapshot.url === null || !snapshot.isMainFrame) return false
  let parsed: URL
  try {
    parsed = new URL(snapshot.url)
  } catch {
    return false
  }
  return rules.some((rule) => {
    if (rule._tag === "fileProtocol") return parsed.protocol === "file:"
    if (rule._tag === "exactUrl") return parsed.href === rule.url
    if (parsed.origin === "null") return false
    return parsed.origin === rule.origin
  })
}

export const payloadSize = (payload: unknown): number => {
  if (payload === undefined || payload === null) return 0
  if (typeof payload === "string") return payload.length
  try {
    return encodePayload(payload).length
  } catch {
    return Number.MAX_SAFE_INTEGER
  }
}

export const bindIpc = Effect.fn("ElectronIpcMain.bindIpc")(function* bindIpc<
  C extends IpcContract,
  R,
  Port
>(
  contract: C,
  handlers: IpcHandlersOf<C, R, Port>,
  config: BindIpcConfig<R, Port>
) {
  const maxBytes = config.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES
  const fibers = yield* FiberSet.make<unknown, never>()
  const runFork = yield* FiberSet.runtime(fibers)<R>()
  const runPromise: <A>(effect: Effect.Effect<A, never, R>) => Promise<A> =
    yield* FiberSet.runtimePromise(fibers)<R>()
  const silentInvoke: Promise<unknown> = runPromise(Effect.void)
  let unbound = false
  const emit: Record<string, (payload: unknown) => void> = {}
  const log = (message: string, cause?: Cause.Cause<unknown>) =>
    Effect.suspend(() => config.log?.(message, cause) ?? Effect.void).pipe(
      Effect.catchCause((loggerCause) =>
        Cause.hasInterrupts(loggerCause) ? Effect.interrupt : Effect.void
      )
    )
  const admit = (
    name: string,
    event: IpcMainEventLike,
    raw: unknown
  ): { readonly sender: IpcSenderInfo } | { readonly rejection: string } => {
    const snapshot = snapshotSender(event, config.target)
    if (!validateSender(snapshot, config.originRules)) return { rejection: `[ipc] ${name}: sender rejected` }
    if (payloadSize(raw) > maxBytes) return { rejection: `[ipc] ${name}: payload exceeds ${maxBytes} bytes` }
    return { sender: { frameUrl: snapshot.url ?? "" } }
  }
  const dropCause = (name: string, cause: Cause.Cause<unknown>) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.interrupt
      : log(`[ipc] ${name}: dropped`, cause)

  yield* Effect.gen(function* () {
    for (const [key, channel] of Object.entries<AnyIpcChannel>(contract.channels)) {
      const name = wireName(contract, key as keyof C["channels"] & string)
      const handler = (handlers as Record<string, unknown>)[key]
      switch (channel._kind) {
      case "send": {
        const run = handler as (payload: unknown, sender: IpcSenderInfo) => Effect.Effect<void, never, R>
        const listener = (event: IpcMainEventLike, raw: unknown) => {
          if (unbound) return
          const admission = admit(name, event, raw)
          if ("rejection" in admission) {
            runFork(log(admission.rejection))
            return
          }
          runFork(
            Schema.decodeUnknownEffect(codec(channel.payload))(raw).pipe(
              Effect.flatMap((payload) => run(payload, admission.sender)),
              Effect.catchCause((cause) => dropCause(name, cause))
            )
          )
        }
        yield* Effect.acquireRelease(
          Effect.sync(() => config.ipc.on(name, listener)),
          (dispose) => Effect.sync(dispose)
        )
        break
      }
      case "invoke": {
        const run = handler as (payload: unknown, sender: IpcSenderInfo) => Effect.Effect<unknown, unknown, R>
        const invokeHandler = (event: IpcMainEventLike, raw: unknown): Promise<unknown> => {
          if (unbound) return silentInvoke
          const admission = admit(name, event, raw)
          if ("rejection" in admission) {
            runFork(log(admission.rejection))
            return silentInvoke
          }
          const program = Schema.decodeUnknownEffect(codec(channel.payload))(raw).pipe(
            Effect.mapError((error) => `payload decode failed: ${String(error)}`),
            Effect.flatMap((payload) =>
              run(payload, admission.sender).pipe(
                Effect.matchEffect({
                  onFailure: (domainError) =>
                    Schema.encodeUnknownEffect(codec(channel.error))(domainError).pipe(
                      Effect.orDie,
                      Effect.map((encoded): ResultEnvelope => ({ _tag: "IpcFailure", error: encoded }))
                    ),
                  onSuccess: (value) =>
                    Schema.encodeUnknownEffect(codec(channel.success))(value).pipe(
                      Effect.orDie,
                      Effect.map((encoded): ResultEnvelope => ({ _tag: "IpcSuccess", value: encoded }))
                    )
                })
              )
            ),
            Effect.matchEffect({
              onFailure: (message) => Effect.succeed<ResultEnvelope>({ _tag: "IpcDefect", message }),
              onSuccess: (result) => Effect.succeed(result)
            }),
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : log(`[ipc] ${name}: defect`, cause).pipe(
                    Effect.as<ResultEnvelope>({ _tag: "IpcDefect", message: "internal error" })
                  )
            )
          )
          return runPromise(program)
        }
        yield* Effect.acquireRelease(
          Effect.sync(() => config.ipc.handle(name, invokeHandler)),
          (dispose) => Effect.sync(dispose)
        )
        break
      }
      case "event": {
        emit[key] = (payload: unknown) => {
          if (unbound) return
          runFork(
            Schema.encodeUnknownEffect(codec((channel as EventChannel).payload))(payload).pipe(
              Effect.flatMap((encoded) =>
                Effect.sync(() => config.target.postToRenderer(name, encoded, []))
              ),
              Effect.catchCause((cause) => dropCause(name, cause))
            )
          )
        }
        break
      }
      case "portExchange": {
        const run = handler as (
          sender: IpcSenderInfo,
          grant: (port: Port) => Effect.Effect<void>
        ) => Effect.Effect<void, never, R>
        const requestChannel = portRequestName(contract, key)
        const grantChannel = portGrantName(contract, key)
        const listener = (event: IpcMainEventLike, raw: unknown) => {
          if (unbound) return
          const admission = admit(requestChannel, event, raw)
          if ("rejection" in admission) {
            runFork(log(admission.rejection))
            return
          }
          runFork(
            Schema.decodeUnknownEffect(PortRequest)(raw).pipe(
              Effect.flatMap(({ nonce }) =>
                run(
                  admission.sender,
                  (port) => Effect.sync(() => config.target.postToRenderer(grantChannel, { nonce }, [port]))
                )
              ),
              Effect.catchCause((cause) => dropCause(requestChannel, cause))
            )
          )
        }
        yield* Effect.acquireRelease(
          Effect.sync(() => config.ipc.on(requestChannel, listener)),
          (dispose) => Effect.sync(dispose)
        )
        break
      }
      }
    }
    yield* Effect.addFinalizer(() => Effect.sync(() => { unbound = true }))
  }).pipe(
    Effect.onExit((exit) => Exit.isFailure(exit)
      ? Effect.sync(() => { unbound = true })
      : Effect.void)
  )
  return { emit: emit as IpcEmitterOf<C> }
})

const encodePayload = Schema.encodeSync(Schema.UnknownFromJsonString)
const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024

const codec = (schema: Schema.Top): Schema.Codec<unknown, unknown> =>
  schema as unknown as Schema.Codec<unknown, unknown>

const PortRequest = Schema.Struct({ nonce: Schema.String })

interface BoundIpc<C extends IpcContract> {
  readonly emit: IpcEmitterOf<C>
}
