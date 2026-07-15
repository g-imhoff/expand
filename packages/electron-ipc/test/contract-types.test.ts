// packages/electron-ipc/test/contract-types.test.ts
import { describe, expectTypeOf, it } from "vitest"
import { Schema } from "effect"
import type { Effect } from "effect"
import { IpcChannel, IpcContract } from "@expand/electron-ipc/contract"
import type { IpcBridgeOf, IpcEmitterOf, IpcHandlersOf, IpcSenderInfo, WireName } from "@expand/electron-ipc/contract"
import type { IpcMainLike } from "@expand/electron-ipc/main"

const Sample = IpcContract.make("sample", {
  ping: IpcChannel.send({ payload: Schema.Struct({ at: Schema.Number }) }),
  // `seek` carries a transform payload (Encoded `string`, Type `number`) so the
  // central Encoded/Type split is observable on a send-or-invoke channel.
  seek: IpcChannel.send({ payload: Schema.Struct({ pos: Schema.FiniteFromString }) }),
  add: IpcChannel.invoke({
    payload: Schema.Struct({ a: Schema.Number, b: Schema.Number }),
    success: Schema.Number,
    error: Schema.Struct({ _tag: Schema.Literal("AddFailed") })
  }),
  // `tick` likewise carries a transform payload so the split is observable on the event leg.
  tick: IpcChannel.event({ payload: Schema.Struct({ seq: Schema.FiniteFromString }) }),
  rpcPort: IpcChannel.portExchange()
})

describe("type derivations", () => {
  it("IpcBridgeOf derives the preload surface (encoded types)", () => {
    type Bridge = IpcBridgeOf<typeof Sample>
    expectTypeOf<keyof Bridge>().toEqualTypeOf<"ping" | "seek" | "add" | "tick" | "rpcPort">()
    expectTypeOf<Bridge["ping"]>().toEqualTypeOf<(payload: { readonly at: number }) => void>()
    // Encoded side: the transform payload surfaces as `string` on the bridge.
    expectTypeOf<Bridge["seek"]>().toEqualTypeOf<(payload: { readonly pos: string }) => void>()
    expectTypeOf<Parameters<Bridge["add"]>[0]>().toEqualTypeOf<{ readonly a: number; readonly b: number }>()
    expectTypeOf<ReturnType<Bridge["add"]>>().toEqualTypeOf<
      ReturnType<Parameters<IpcMainLike["handle"]>[1]>
    >()
    expectTypeOf<Bridge["tick"]>().toEqualTypeOf<(listener: (payload: { readonly seq: string }) => void) => () => void>()
    expectTypeOf<Bridge["rpcPort"]>().toEqualTypeOf<(nonce: string) => void>()
  })

  it("IpcHandlersOf derives handler signatures and excludes event channels", () => {
    type Handlers = IpcHandlersOf<typeof Sample, "REQ", "PORT">
    expectTypeOf<Handlers["ping"]>().toEqualTypeOf<
      (payload: { readonly at: number }, sender: IpcSenderInfo) => Effect.Effect<void, never, "REQ">
    >()
    // Decoded side: the transform payload surfaces as `number` in handlers.
    expectTypeOf<Handlers["seek"]>().toEqualTypeOf<
      (payload: { readonly pos: number }, sender: IpcSenderInfo) => Effect.Effect<void, never, "REQ">
    >()
    expectTypeOf<Handlers["add"]>().toEqualTypeOf<
      (
        payload: { readonly a: number; readonly b: number },
        sender: IpcSenderInfo
      ) => Effect.Effect<number, { readonly _tag: "AddFailed" }, "REQ">
    >()
    expectTypeOf<Handlers["rpcPort"]>().toEqualTypeOf<
      (
        sender: IpcSenderInfo,
        grant: (port: "PORT") => Effect.Effect<void>
      ) => Effect.Effect<void, never, "REQ">
    >()
    expectTypeOf<keyof Handlers>().toEqualTypeOf<"ping" | "seek" | "add" | "rpcPort">()
  })

  it("IpcEmitterOf derives emitters for event channels only", () => {
    type Emitters = IpcEmitterOf<typeof Sample>
    expectTypeOf<keyof Emitters>().toEqualTypeOf<"tick">()
    // Decoded side: the transform payload surfaces as `number` on the emitter.
    expectTypeOf<Emitters["tick"]>().toEqualTypeOf<(payload: { readonly seq: number }) => void>()
  })

  it("WireName composes the prefix and channel key", () => {
    expectTypeOf<WireName<typeof Sample, "add">>().toEqualTypeOf<"sample:add">()
  })
})
