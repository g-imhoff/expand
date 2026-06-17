// Main interpreter: the authoritative trust boundary. MUST NOT import "electron";
// the adapter in main-electron.ts narrows real Electron objects to the structural
// interfaces below (same idiom as MainPortLike). The pure validation half is
// zero-import; the bindIpc interpreter below depends only on `effect` and the
// pure contract module — never on electron.
//
// Security pipeline (spec §7.2), in order, for EVERY kind including send:
//   1. snapshotSender (synchronous — frames may detach after any await)
//   2. validateSender (parsed-URL exact origin match; main frame only)
//   3. payload size guard
//   4. Schema decode (failure: drop for send/portExchange, defect envelope for invoke)
//   5. typed handler dispatch
import { Effect, Schema } from "effect"
import type {
  AnyIpcChannel,
  EventChannel,
  IpcContract,
  IpcEmitterOf,
  IpcHandlersOf,
  IpcSenderInfo,
  ResultEnvelope
} from "@yodea/electron-ipc/contract"
import { portGrantName, portRequestName, wireName } from "@yodea/electron-ipc/contract"

export type OriginRule =
  /**
   * Match a single serialized origin exactly. `origin` MUST already be in normalized
   * serialized form — lowercase host, no trailing slash, no default port
   * (e.g. "http://localhost:5173", "https://app.example.com"). It is compared verbatim
   * against the parsed URL's `origin`, so it can never match the literal "null" of an
   * opaque origin.
   */
  | { readonly _tag: "exactOrigin"; readonly origin: string }
  | { readonly _tag: "fileProtocol" }

export interface FrameLike {
  readonly url: string
  readonly detached: boolean
}

// Note: main-frame status is decided by OBJECT IDENTITY (frame === target.mainFrame),
// so adapters MUST hand the same frame references to snapshotSender on both the event
// and target paths — see snapshotSender.

export interface IpcMainEventLike {
  readonly sender: unknown
  readonly senderFrame: FrameLike | null
}

export interface WindowTargetLike {
  readonly webContents: unknown
  readonly mainFrame: FrameLike | null
  readonly postToRenderer: (channel: string, payload: unknown, transfer: ReadonlyArray<unknown>) => void
}

export interface FrameSnapshot {
  readonly url: string | null
  readonly isMainFrame: boolean
}

/**
 * Synchronous sender snapshot. MUST be called before any await/yield.
 *
 * isMainFrame is determined by OBJECT IDENTITY (`frame === target.mainFrame`), not by
 * url or any other field. Adapters MUST pass the SAME frame object references on both the
 * event and target paths; re-wrapping frames into fresh objects compiles fine but makes
 * isMainFrame permanently false (the identity check can never succeed).
 */
export const snapshotSender = (event: IpcMainEventLike, target: WindowTargetLike): FrameSnapshot => {
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
  // Opaque origins (data:, about:blank, sandboxed frames — file: in some serializations)
  // parse to the literal origin "null". Only a fileProtocol rule may admit them, and only
  // via the protocol check below; an exactOrigin rule must NEVER match the string "null".
  return rules.some((rule) => {
    if (rule._tag === "fileProtocol") return parsed.protocol === "file:"
    if (parsed.origin === "null") return false
    return parsed.origin === rule.origin
  })
}

/** Cheap DoS guard. Unserializable payloads count as oversized. */
export const payloadSize = (payload: unknown): number => {
  if (payload === undefined || payload === null) return 0
  if (typeof payload === "string") return payload.length
  try {
    // JSON.stringify returns undefined (no throw) for functions/symbols. Fail closed:
    // count an unrepresentable payload as oversized rather than under-counting it as 0.
    return JSON.stringify(payload)?.length ?? Number.MAX_SAFE_INTEGER
  } catch {
    return Number.MAX_SAFE_INTEGER
  }
}

/**
 * Default payload cap. Approximate: the guard measures UTF-16 code units (string length /
 * JSON.stringify length), NOT encoded UTF-8 bytes — worst case it under-counts by ~3x vs
 * UTF-8. That imprecision is fine for a coarse DoS guard.
 */
const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024

// ---------------------------------------------------------------------------
// bindIpc: the main-process interpreter
// ---------------------------------------------------------------------------

// Boundary codecs operate on generic `Schema.Top` fields. The sync/effect codec
// helpers constrain to `Schema.Codec<unknown>` (service-free RD/RE = never), which
// `Schema.Top` (RD/RE = unknown) does not satisfy structurally. IPC payloads are
// wire-shaped and carry no service requirements, so we narrow each field to a
// service-free codec at the call site. (Mirror of renderer.ts; duplication ok.)
const codec = (schema: Schema.Top): Schema.Codec<unknown, unknown> =>
  schema as unknown as Schema.Codec<unknown, unknown>

export interface IpcMainLike {
  readonly on: (channel: string, listener: (event: IpcMainEventLike, payload: unknown) => void) => void
  readonly removeListener: (channel: string, listener: (event: IpcMainEventLike, payload: unknown) => void) => void
  readonly handle: (channel: string, handler: (event: IpcMainEventLike, payload: unknown) => Promise<unknown>) => void
  readonly removeHandler: (channel: string) => void
}

export interface BindIpcConfig<R> {
  /** Named `ipc` (not the raw main-side primitive) so app code never contains the token the architecture test scans for. */
  readonly ipc: IpcMainLike
  readonly target: WindowTargetLike
  readonly originRules: ReadonlyArray<OriginRule>
  readonly runPromise: <A, E>(effect: Effect.Effect<A, E, R>) => Promise<A>
  readonly maxPayloadBytes?: number
  readonly log?: (message: string) => void
}

export interface BoundIpc<C extends IpcContract> {
  readonly emit: IpcEmitterOf<C>
  readonly unbind: () => void
}

const PortRequest = Schema.Struct({ nonce: Schema.String })

export const bindIpc = <C extends IpcContract, R, Port>(
  contract: C,
  handlers: IpcHandlersOf<C, R, Port>,
  config: BindIpcConfig<R>
): BoundIpc<C> => {
  const maxBytes = config.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES
  // Wrap the configured log once so a throwing logger can never escape the boundary —
  // notably the invoke catchCause path, where a throw would let a raw rejection (with its
  // unsanitized message) cross to the renderer instead of the neutral defect envelope.
  const configLog = config.log ?? (() => {})
  const log = (message: string) => {
    try {
      configLog(message)
    } catch {
      // never throw across the boundary
    }
  }
  let unbound = false
  const teardowns: Array<() => void> = []
  const emit: Record<string, (payload: unknown) => void> = {}

  // Steps 1-3 of the pipeline, shared by every kind. Returns null on rejection.
  const admit = (name: string, event: IpcMainEventLike, raw: unknown): IpcSenderInfo | null => {
    const snapshot = snapshotSender(event, config.target)
    if (!validateSender(snapshot, config.originRules)) {
      log(`[ipc] ${name}: sender rejected`)
      return null
    }
    if (payloadSize(raw) > maxBytes) {
      log(`[ipc] ${name}: payload exceeds ${maxBytes} bytes`)
      return null
    }
    return { frameUrl: snapshot.url ?? "" }
  }

  for (const [key, channel] of Object.entries<AnyIpcChannel>(contract.channels)) {
    const name = wireName(contract, key as keyof C["channels"] & string)
    const handler = (handlers as Record<string, unknown>)[key]

    switch (channel._kind) {
      case "send": {
        const run = handler as (payload: unknown, sender: IpcSenderInfo) => Effect.Effect<void, never, R>
        const listener = (event: IpcMainEventLike, raw: unknown) => {
          const sender = admit(name, event, raw)
          if (sender === null) return
          const program = Schema.decodeUnknownEffect(codec(channel.payload))(raw).pipe(
            Effect.flatMap((payload) => run(payload, sender)),
            Effect.catchCause((cause) => Effect.sync(() => log(`[ipc] ${name}: dropped (${String(cause)})`)))
          )
          void config.runPromise(program as Effect.Effect<unknown, never, R>).catch(() => {})
        }
        config.ipc.on(name, listener)
        teardowns.push(() => config.ipc.removeListener(name, listener))
        break
      }

      case "invoke": {
        const run = handler as (payload: unknown, sender: IpcSenderInfo) => Effect.Effect<unknown, unknown, R>
        const invokeHandler = (event: IpcMainEventLike, raw: unknown): Promise<unknown> => {
          const sender = admit(name, event, raw)
          if (sender === null) return Promise.resolve(undefined) // silent: no probe oracle
          const program: Effect.Effect<ResultEnvelope, never, R> = Schema.decodeUnknownEffect(codec(channel.payload))(
            raw
          ).pipe(
            Effect.mapError((error) => `payload decode failed: ${String(error)}`),
            Effect.flatMap((payload) =>
              run(payload, sender).pipe(
                Effect.flatMap((value) =>
                  Schema.encodeUnknownEffect(codec(channel.success))(value).pipe(
                    Effect.orDie,
                    Effect.map((encoded): ResultEnvelope => ({ _tag: "IpcSuccess", value: encoded }))
                  )
                ),
                Effect.catch((domainError) =>
                  Schema.encodeUnknownEffect(codec(channel.error))(domainError).pipe(
                    Effect.orDie,
                    Effect.map((encoded): ResultEnvelope => ({ _tag: "IpcFailure", error: encoded }))
                  )
                )
              )
            ),
            // Decode failure from a VALIDATED sender → typed Defect envelope (fast feedback).
            Effect.catch((message) => Effect.succeed<ResultEnvelope>({ _tag: "IpcDefect", message })),
            // Handler/encode defects → sanitized; full cause goes to the log only.
            Effect.catchCause((cause) =>
              Effect.sync((): ResultEnvelope => {
                log(`[ipc] ${name}: defect (${String(cause)})`)
                return { _tag: "IpcDefect", message: "internal error" }
              })
            )
          )
          return config.runPromise(program)
        }
        config.ipc.handle(name, invokeHandler)
        teardowns.push(() => config.ipc.removeHandler(name))
        break
      }

      case "event": {
        emit[key] = (payload: unknown) => {
          // After unbind the underlying target may be gone (the real adapter's
          // postToRenderer throws on destroyed windows) — drop the emit silently.
          if (unbound) return
          const encoded = Schema.encodeUnknownSync(codec((channel as EventChannel).payload))(payload)
          config.target.postToRenderer(name, encoded, [])
        }
        break
      }

      case "portExchange": {
        const run = handler as (sender: IpcSenderInfo) => Effect.Effect<Port, never, R>
        const requestChannel = portRequestName(contract, key)
        const grantChannel = portGrantName(contract, key)
        const listener = (event: IpcMainEventLike, raw: unknown) => {
          const sender = admit(requestChannel, event, raw)
          if (sender === null) return
          const program = Schema.decodeUnknownEffect(PortRequest)(raw).pipe(
            Effect.flatMap(({ nonce }) =>
              run(sender).pipe(
                Effect.map((port) => config.target.postToRenderer(grantChannel, { nonce }, [port]))
              )
            ),
            Effect.catchCause((cause) => Effect.sync(() => log(`[ipc] ${requestChannel}: dropped (${String(cause)})`)))
          )
          void config.runPromise(program as Effect.Effect<unknown, never, R>).catch(() => {})
        }
        config.ipc.on(requestChannel, listener)
        teardowns.push(() => config.ipc.removeListener(requestChannel, listener))
        break
      }
    }
  }

  return {
    emit: emit as IpcEmitterOf<C>,
    unbind: () => {
      unbound = true
      for (const teardown of teardowns) teardown()
    }
  }
}
