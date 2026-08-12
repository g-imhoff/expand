import type { Schema } from "effect"
import type { Effect } from "effect"

export interface SendChannel<P extends Schema.Top = Schema.Top> { readonly _kind: "send"; readonly payload: P }
export interface InvokeChannel<P extends Schema.Top = Schema.Top, S extends Schema.Top = Schema.Top, E extends Schema.Top = Schema.Top> { readonly _kind: "invoke"; readonly payload: P; readonly success: S; readonly error: E }
export interface EventChannel<P extends Schema.Top = Schema.Top> { readonly _kind: "event"; readonly payload: P }
export interface PortExchangeChannel { readonly _kind: "portExchange" }
export interface Contract<Prefix extends string = string, Channels extends Record<string, AnyChannel> = Record<string, AnyChannel>> { readonly prefix: Prefix; readonly channels: Channels }

export type AnyChannel = SendChannel | InvokeChannel | EventChannel | PortExchangeChannel
export type Sender = { readonly frameUrl: string }
export type Handlers<C extends Contract, R, Port> = {
  readonly [K in keyof C["channels"] & string as C["channels"][K] extends EventChannel ? never : K]: C["channels"][K] extends InvokeChannel<infer P, infer S, infer E> ? (payload: P["Type"], sender: Sender) => Effect.Effect<S["Type"], E["Type"], R> : C["channels"][K] extends SendChannel<infer P> ? (payload: P["Type"], sender: Sender) => Effect.Effect<void, never, R> : C["channels"][K] extends PortExchangeChannel ? (sender: Sender, grant: (port: Port) => Effect.Effect<void>) => Effect.Effect<void, never, R> : never
}
export type EventKeys<C extends Contract> = { [K in keyof C["channels"] & string]: C["channels"][K] extends EventChannel ? K : never }[keyof C["channels"] & string]
export type Emitter<C extends Contract> = { readonly [K in EventKeys<C>]: C["channels"][K] extends EventChannel<infer P> ? (payload: P["Type"]) => void : never }
export type Bridge<C extends Contract> = { readonly [K in keyof C["channels"] & string]: C["channels"][K] extends InvokeChannel ? (payload: C["channels"][K]["payload"]["Encoded"]) => Promise<unknown> : C["channels"][K] extends SendChannel ? (payload: C["channels"][K]["payload"]["Encoded"]) => void : C["channels"][K] extends EventChannel ? (listener: (payload: C["channels"][K]["payload"]["Encoded"]) => void) => () => void : C["channels"][K] extends PortExchangeChannel ? (nonce: string) => void : never }
export type Result = { readonly _tag: "IpcSuccess"; readonly value: unknown } | { readonly _tag: "IpcFailure"; readonly error: unknown } | { readonly _tag: "IpcDefect"; readonly message: string }
export const isStrictResult = (value: unknown): value is Result => {
  if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype) return false
  const keys = Reflect.ownKeys(value)
  const tagDescriptor = Object.getOwnPropertyDescriptor(value, "_tag")
  if (tagDescriptor === undefined || !Object.prototype.hasOwnProperty.call(tagDescriptor, "value")) return false
  const tag = tagDescriptor.value
  const expected = tag === "IpcSuccess" ? "value" : tag === "IpcFailure" ? "error" : tag === "IpcDefect" ? "message" : undefined
  if (expected === undefined || keys.length !== 2 || !keys.includes(expected)) return false
  const payloadDescriptor = Object.getOwnPropertyDescriptor(value, expected)
  if (payloadDescriptor === undefined || !Object.prototype.hasOwnProperty.call(payloadDescriptor, "value")) return false
  return expected !== "message" || typeof payloadDescriptor.value === "string"
}
export const wire = (c: Contract, key: string) => `${c.prefix}:${key}`
export const requestWire = (c: Contract, key: string) => `${wire(c, key)}:request`
export const grantWire = (c: Contract, key: string) => `${wire(c, key)}:grant`
