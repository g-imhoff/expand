import type { Schema } from "effect"
import type { Contract, AnyChannel, Emitter, Handlers } from "./internal/contract"

export type IpcContract<Prefix extends string = string, Channels extends Record<string, AnyChannel> = Record<string, AnyChannel>> = Contract<Prefix, Channels>
export type IpcHandlersOf<C extends IpcContract, R = never, Port = MessagePort> = Handlers<C, R, Port>
export type IpcEmitterOf<C extends IpcContract> = Emitter<C>

export const IpcChannel = {
  send: <P extends Schema.Top>(options: { readonly payload: P }) => ({ _kind: "send", payload: options.payload } as const),
  invoke: <P extends Schema.Top, S extends Schema.Top, E extends Schema.Top>(options: { readonly payload: P; readonly success: S; readonly error: E }) => ({ _kind: "invoke", payload: options.payload, success: options.success, error: options.error } as const),
  event: <P extends Schema.Top>(options: { readonly payload: P }) => ({ _kind: "event", payload: options.payload } as const),
  portExchange: () => ({ _kind: "portExchange" } as const)
}

export const IpcContract = {
  make: <const Prefix extends string, const Channels extends Record<string, AnyChannel>>(prefix: Prefix, channels: Channels): IpcContract<Prefix, Channels> => {
    if (!/^[a-z][a-zA-Z0-9]*$/.test(prefix)) throw new Error(`invalid prefix "${prefix}"`)
    for (const key of Object.keys(channels)) if (!/^[a-z][a-zA-Z0-9]*$/.test(key)) throw new Error(`invalid channel key "${key}"`)
    return { prefix, channels }
  }
}
