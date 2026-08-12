import { Effect, FiberSet, Schema } from "effect"
import type { Scope } from "effect"
import { ipcMain } from "electron"
import type { BrowserWindow, MessagePortMain } from "electron"
import type { IpcContract, IpcEmitterOf, IpcHandlersOf } from "./contract"
import type { AnyChannel, Result } from "./internal/contract"
import { grantWire, requestWire, wire } from "./internal/contract"
import { exactUrl, utf8Bytes } from "./internal/wire"

export const bindElectronIpc = <C extends IpcContract, R = never>(contract: C, handlers: IpcHandlersOf<C, R, MessagePortMain>, options: {
  readonly window: BrowserWindow
  readonly rendererOrigin?: string
  readonly rendererUrl?: string
  readonly maxPayloadBytes?: number
}): Effect.Effect<IpcEmitterOf<C>, unknown, R | Scope.Scope> => Effect.gen(function* () {
  const fibers = yield* FiberSet.make<unknown, never>()
  const runPromise: <A>(effect: Effect.Effect<A, never, R>) => Promise<A> = yield* FiberSet.runtimePromise(fibers)<R>()
  return yield* Effect.acquireRelease(
  Effect.sync(() => {
    if ((options.rendererOrigin === undefined) === (options.rendererUrl === undefined)) throw new Error("exactly one rendererOrigin or rendererUrl is required")
    const location = options.rendererOrigin === undefined ? exactUrl(options.rendererUrl!, "url") : exactUrl(options.rendererOrigin, "origin")
    if (options.rendererOrigin !== undefined && options.rendererOrigin !== new URL(location).origin) throw new Error("rendererOrigin must be canonical")
    if (options.rendererUrl !== undefined && options.rendererUrl !== location) throw new Error("rendererUrl must be canonical")
    const max = options.maxPayloadBytes ?? DEFAULT_MAX
    if (!Number.isSafeInteger(max) || max <= 0) throw new Error("maxPayloadBytes must be a positive safe integer")
    let active = true
    const disposers: Array<() => void> = []
    const emit: Record<string, (payload: unknown) => void> = {}
    const admitted = (event: unknown, payload: unknown): { frameUrl: string } | undefined => {
      const source = eventObject(event)
      const frame = source?.senderFrame
      const target = options.window.webContents
      if (source?.sender !== target || frame === null || frame === undefined || frame.detached || frame !== target.mainFrame) return undefined
      let parsed: URL
      try { parsed = new URL(frame.url) } catch { return undefined }
      if (options.rendererOrigin !== undefined ? parsed.origin !== location : parsed.href !== location) return undefined
      if (utf8Bytes(payload) > max) return undefined
      return { frameUrl: frame.url }
    }
    const run = (effect: Effect.Effect<unknown, unknown, R>) => {
      void runPromise(effect as Effect.Effect<unknown, never, R>).catch(() => undefined)
    }
    const stop = () => {
      if (!active) return
      active = false
      const failures: Array<unknown> = []
      for (const dispose of disposers.splice(0).reverse()) {
        try { dispose() } catch (error) { failures.push(error) }
      }
      if (failures.length > 0) throw new AggregateError(failures, "ipc binding cleanup failed")
    }
    try {
      for (const [key, channel] of Object.entries<AnyChannel>(contract.channels)) {
        const name = wire(contract, key)
        const handler = (handlers as unknown as Record<string, unknown>)[key]
        if (channel._kind === "send") {
          const listener = (event: unknown, raw: unknown) => {
            const sender = admitted(event, raw)
            if (!active || !sender) return
            run(Schema.decodeUnknownEffect(codec(channel.payload))(raw).pipe(
              Effect.flatMap((p: unknown) => (handler as (p: unknown, s: { frameUrl: string }) => Effect.Effect<unknown, unknown, R>)(p, sender))
            ) as Effect.Effect<unknown, unknown, R>)
          }
          ipcMain.on(name, listener)
          disposers.push(() => ipcMain.off(name, listener))
        } else if (channel._kind === "invoke") {
          const invoke = (event: unknown, raw: unknown): Promise<Result> => {
            const sender = admitted(event, raw)
            if (!active || !sender) return Promise.resolve({ _tag: "IpcDefect", message: "sender rejected" })
            const program = Schema.decodeUnknownEffect(codec(channel.payload))(raw).pipe(
              Effect.flatMap((payload) => (handler as (p: unknown, s: { frameUrl: string }) => Effect.Effect<unknown, unknown, R>)(payload, sender).pipe(Effect.matchEffect({
                onSuccess: (value) => Schema.encodeUnknownEffect(codec(channel.success))(value).pipe(Effect.map((encoded) => ({ _tag: "IpcSuccess", value: encoded } as Result))),
                onFailure: (error) => Schema.encodeUnknownEffect(codec(channel.error))(error).pipe(Effect.map((encoded) => ({ _tag: "IpcFailure", error: encoded } as Result)))
              }))),
              Effect.catchCause(() => Effect.succeed<Result>({ _tag: "IpcDefect", message: "internal error" }))
            )
            return runPromise(program as Effect.Effect<Result, never, R>)
          }
          ipcMain.handle(name, invoke)
          disposers.push(() => ipcMain.removeHandler(name))
        } else if (channel._kind === "event") {
          emit[key] = (payload: unknown) => {
            if (!active) return
            try {
              const encoded = Schema.encodeSync(codec(channel.payload))(payload)
              if (utf8Bytes(encoded) > max) return
              options.window.webContents.send(name, encoded)
            } catch { }
          }
        } else {
          const request = requestWire(contract, key)
          const listener = (event: unknown, raw: unknown) => {
            const sender = admitted(event, raw)
            if (!active || !sender) return
            run(Schema.decodeUnknownEffect(requestSchema)(raw).pipe(
              Effect.flatMap(({ nonce }) => (handler as (s: { frameUrl: string }, grant: (port: MessagePortMain) => Effect.Effect<void>) => Effect.Effect<void, never, R>)(sender, (port: MessagePortMain) => Effect.sync(() => options.window.webContents.postMessage(grantWire(contract, key), { nonce }, [port]))))
            ) as Effect.Effect<unknown, unknown, R>)
          }
          ipcMain.on(request, listener)
          disposers.push(() => ipcMain.off(request, listener))
        }
      }
    } catch (error) {
      try { stop() } catch (cleanup) {
        const cleanupErrors = cleanup instanceof AggregateError ? cleanup.errors : [cleanup]
        throw new AggregateError([error, ...cleanupErrors], "ipc binding acquisition failed")
      }
      throw error
    }
    return { emit: emit as IpcEmitterOf<C>, stop }
  }),
  (bound) => Effect.sync(bound.stop)
  ).pipe(Effect.map((bound) => bound.emit))
})

const DEFAULT_MAX = 1024 * 1024
const codec = (schema: Schema.Top): Schema.Encoder<unknown, never> & Schema.Decoder<unknown, never> => schema as unknown as Schema.Encoder<unknown, never> & Schema.Decoder<unknown, never>
const requestSchema = Schema.Struct({ nonce: Schema.String })
const eventObject = (value: unknown): { readonly sender?: unknown; readonly senderFrame?: { readonly url: string; readonly detached: boolean } | null } | undefined => typeof value === "object" && value !== null ? value as { readonly sender?: unknown; readonly senderFrame?: { readonly url: string; readonly detached: boolean } | null } : undefined
