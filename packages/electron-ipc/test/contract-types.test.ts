// packages/electron-ipc/test/contract-types.test.ts
import { describe, expectTypeOf, it } from "vitest"
import { Schema } from "effect"
import type { Effect } from "effect"
import { IpcChannel, IpcContract } from "@yodea/electron-ipc/contract"
import type { IpcBridgeOf, IpcEmitterOf, IpcHandlersOf, IpcSenderInfo } from "@yodea/electron-ipc/contract"

const Sample = IpcContract.make("sample", {
  ping: IpcChannel.send({ payload: Schema.Struct({ at: Schema.Number }) }),
  add: IpcChannel.invoke({
    payload: Schema.Struct({ a: Schema.Number, b: Schema.Number }),
    success: Schema.Number,
    error: Schema.Struct({ _tag: Schema.Literal("AddFailed") })
  }),
  tick: IpcChannel.event({ payload: Schema.Struct({ seq: Schema.Number }) }),
  rpcPort: IpcChannel.portExchange()
})

describe("type derivations", () => {
  it("IpcBridgeOf derives the preload surface (encoded types)", () => {
    type Bridge = IpcBridgeOf<typeof Sample>
    expectTypeOf<Bridge["ping"]>().toEqualTypeOf<(payload: { readonly at: number }) => void>()
    expectTypeOf<Bridge["add"]>().toEqualTypeOf<(payload: { readonly a: number; readonly b: number }) => Promise<unknown>>()
    expectTypeOf<Bridge["tick"]>().toEqualTypeOf<(listener: (payload: { readonly seq: number }) => void) => () => void>()
    expectTypeOf<Bridge["rpcPort"]>().toEqualTypeOf<(nonce: string) => void>()
  })

  it("IpcHandlersOf derives handler signatures and excludes event channels", () => {
    type Handlers = IpcHandlersOf<typeof Sample, never, "PORT">
    expectTypeOf<Handlers["ping"]>().toEqualTypeOf<
      (payload: { readonly at: number }, sender: IpcSenderInfo) => Effect.Effect<void, never, never>
    >()
    expectTypeOf<Handlers["add"]>().toEqualTypeOf<
      (
        payload: { readonly a: number; readonly b: number },
        sender: IpcSenderInfo
      ) => Effect.Effect<number, { readonly _tag: "AddFailed" }, never>
    >()
    expectTypeOf<Handlers["rpcPort"]>().toEqualTypeOf<(sender: IpcSenderInfo) => Effect.Effect<"PORT", never, never>>()
    expectTypeOf<keyof Handlers>().toEqualTypeOf<"ping" | "add" | "rpcPort">()
  })

  it("IpcEmitterOf derives emitters for event channels only", () => {
    type Emitters = IpcEmitterOf<typeof Sample>
    expectTypeOf<keyof Emitters>().toEqualTypeOf<"tick">()
    expectTypeOf<Emitters["tick"]>().toEqualTypeOf<(payload: { readonly seq: number }) => void>()
  })
})
