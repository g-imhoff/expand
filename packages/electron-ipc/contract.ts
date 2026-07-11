// Pure contract DSL for the typed Electron IPC framework.
// MUST NOT import "electron" and MUST NOT import effect runtime values beyond Schema
// (preload bundles this module; see test/architecture/ipc-boundary.test.ts).
import type { Effect, Schema } from "effect"

// ---------------------------------------------------------------------------
// Channel kinds (directional by design — see spec §6.1)
// ---------------------------------------------------------------------------

export interface SendChannel<P extends Schema.Top = Schema.Top> {
  readonly _kind: "send"
  readonly payload: P
}

export interface InvokeChannel<
  P extends Schema.Top = Schema.Top,
  S extends Schema.Top = Schema.Top,
  E extends Schema.Top = Schema.Top
> {
  readonly _kind: "invoke"
  readonly payload: P
  readonly success: S
  readonly error: E
}

export interface EventChannel<P extends Schema.Top = Schema.Top> {
  readonly _kind: "event"
  readonly payload: P
}

export interface PortExchangeChannel {
  readonly _kind: "portExchange"
}

// ---------------------------------------------------------------------------
// Contract (the registry)
// ---------------------------------------------------------------------------

export interface IpcContract<
  Prefix extends string = string,
  Channels extends Record<string, AnyIpcChannel> = Record<string, AnyIpcChannel>
> {
  readonly prefix: Prefix
  readonly channels: Channels
}

// ---------------------------------------------------------------------------
// Wire envelopes (plain JSON-ish shapes; cross the context bridge via structured clone)
// ---------------------------------------------------------------------------

export interface SuccessEnvelope {
  readonly _tag: "IpcSuccess"
  readonly value: unknown
}
export interface FailureEnvelope {
  readonly _tag: "IpcFailure"
  readonly error: unknown
}
export interface DefectEnvelope {
  readonly _tag: "IpcDefect"
  readonly message: string
}

/** Marker relayed by the preload into the main world alongside a transferred MessagePort. */
export interface PortGrantMessage {
  readonly _tag: "IpcPortGrant"
  readonly channel: string
  readonly nonce: string
}

/** Sender identity handed to main-side handlers (verified, never renderer-supplied). */
export interface IpcSenderInfo {
  readonly frameUrl: string
}

export type AnyIpcChannel = SendChannel | InvokeChannel | EventChannel | PortExchangeChannel

export const IpcChannel = {
  send: <P extends Schema.Top>(options: { readonly payload: P }): SendChannel<P> => ({
    _kind: "send",
    payload: options.payload
  }),
  invoke: <P extends Schema.Top, S extends Schema.Top, E extends Schema.Top>(options: {
    readonly payload: P
    readonly success: S
    readonly error: E
  }): InvokeChannel<P, S, E> => ({
    _kind: "invoke",
    payload: options.payload,
    success: options.success,
    error: options.error
  }),
  event: <P extends Schema.Top>(options: { readonly payload: P }): EventChannel<P> => ({
    _kind: "event",
    payload: options.payload
  }),
  portExchange: (): PortExchangeChannel => ({ _kind: "portExchange" })
}

export const IpcContract = {
  make: <const Prefix extends string, const Channels extends Record<string, AnyIpcChannel>>(
    prefix: Prefix,
    channels: Channels
  ): IpcContract<Prefix, Channels> => {
    if (!NAME_PATTERN.test(prefix)) {
      throw new Error(`IpcContract: invalid prefix "${prefix}" (must match ${NAME_PATTERN})`)
    }
    for (const key of Object.keys(channels)) {
      if (!NAME_PATTERN.test(key)) {
        throw new Error(`IpcContract: invalid channel key "${key}" (must match ${NAME_PATTERN})`)
      }
    }
    return { prefix, channels }
  }
}

export type WireName<C extends IpcContract, K extends keyof C["channels"] & string> = `${C["prefix"]}:${K}`

export const wireName = <C extends IpcContract, K extends keyof C["channels"] & string>(
  contract: C,
  key: K
): WireName<C, K> => `${contract.prefix}:${key}` as WireName<C, K>

/** Wire name of the renderer→main request leg of a portExchange channel. */
export const portRequestName = (contract: IpcContract, key: string): string =>
  `${contract.prefix}:${key}:request`

/** Wire name of the main→renderer grant leg of a portExchange channel. */
export const portGrantName = (contract: IpcContract, key: string): string =>
  `${contract.prefix}:${key}:grant`

export type ResultEnvelope = SuccessEnvelope | FailureEnvelope | DefectEnvelope

export const isResultEnvelope = (input: unknown): input is ResultEnvelope => {
  if (typeof input !== "object" || input === null) return false
  const tag = (input as { readonly _tag?: unknown })._tag
  // Asymmetry by design: IpcSuccess/IpcFailure carry `unknown` value/error that may
  // legitimately be `undefined`, so a tag check is sufficient. IpcDefect's `message`
  // is `string`, so we must verify it to honour the narrowed type.
  if (tag === "IpcSuccess" || tag === "IpcFailure") return true
  return tag === "IpcDefect" && typeof (input as { readonly message?: unknown }).message === "string"
}

export const isPortGrantMessage = (input: unknown): input is PortGrantMessage => {
  if (typeof input !== "object" || input === null) return false
  const candidate = input as { readonly _tag?: unknown; readonly channel?: unknown; readonly nonce?: unknown }
  return (
    candidate._tag === "IpcPortGrant" &&
    typeof candidate.channel === "string" &&
    typeof candidate.nonce === "string"
  )
}

// ---------------------------------------------------------------------------
// Type-level derivations (consumed by api.d.ts, interpreters, and clients)
// ---------------------------------------------------------------------------

/**
 * The shape exposed on `window[apiKey]` by the preload interpreter. Encoded types only.
 *
 * The invoke branch resolves with an undecoded `ResultEnvelope` typed as `Promise<unknown>`:
 * the bridge layer never decodes. Renderer clients guard the resolved value with
 * `isResultEnvelope` and then Schema-decode the success/error payload themselves.
 */
export type IpcBridgeOf<C extends IpcContract> = {
  readonly [K in keyof C["channels"] & string]: C["channels"][K] extends InvokeChannel<infer P, Schema.Top, Schema.Top>
    ? (payload: P["Encoded"]) => Promise<unknown>
    : C["channels"][K] extends SendChannel<infer P>
      ? (payload: P["Encoded"]) => void
      : C["channels"][K] extends EventChannel<infer P>
        ? (listener: (payload: P["Encoded"]) => void) => () => void
        : C["channels"][K] extends PortExchangeChannel
          ? (nonce: string) => void
          : never
}

/** Keys of event-kind channels (emitted by main, not handled). */
export type EventKeys<C extends IpcContract> = {
  [K in keyof C["channels"] & string]: C["channels"][K] extends EventChannel<Schema.Top> ? K : never
}[keyof C["channels"] & string]

/**
 * Main-side handler map derived from the contract. `Port` is the transferable
 * port type (electron's MessagePortMain — kept generic so this module stays
 * electron-free). Event channels are excluded: main emits them via IpcEmitterOf.
 */
export type IpcHandlersOf<C extends IpcContract, R, Port> = {
  readonly [K in keyof C["channels"] & string as C["channels"][K] extends EventChannel<Schema.Top>
    ? never
    : K]: C["channels"][K] extends InvokeChannel<infer P, infer S, infer E>
    ? (payload: P["Type"], sender: IpcSenderInfo) => Effect.Effect<S["Type"], E["Type"], R>
    : C["channels"][K] extends SendChannel<infer P>
      ? (payload: P["Type"], sender: IpcSenderInfo) => Effect.Effect<void, never, R>
      : C["channels"][K] extends PortExchangeChannel
        ? (sender: IpcSenderInfo) => Effect.Effect<Port, never, R>
        : never
}

/** Main-side emitters for event-kind channels. */
export type IpcEmitterOf<C extends IpcContract> = {
  readonly [K in EventKeys<C>]: C["channels"][K] extends EventChannel<infer P> ? (payload: P["Type"]) => void : never
}

const NAME_PATTERN = /^[a-z][a-zA-Z0-9]*$/
