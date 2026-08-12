import { Effect, Schema } from "effect"
import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { IpcChannel, IpcContract } from "../contract"

describe("Electron IPC public facade", () => {
  it("constructs validated channels and contracts", () => {
    const contract = IpcContract.make("sample", {
      send: IpcChannel.send({ payload: Schema.String }),
      invoke: IpcChannel.invoke({ payload: Schema.String, success: Schema.Number, error: Schema.String }),
      event: IpcChannel.event({ payload: Schema.Number }),
      port: IpcChannel.portExchange()
    })
    expect(contract.prefix).toBe("sample")
    expect(Object.keys(contract.channels)).toEqual(["send", "invoke", "event", "port"])
  })

  it.effect("exposes only the intentional runtime entrypoint names", () => Effect.gen(function* () {
    const contract = yield* Effect.promise(() => import("../contract"))
    const main = yield* Effect.promise(() => import("../main"))
    const preload = yield* Effect.promise(() => import("../preload"))
    const renderer = yield* Effect.promise(() => import("../renderer"))
    expect(Object.keys(contract).sort()).toEqual(["IpcChannel", "IpcContract"])
    expect(Object.keys(main)).toEqual(["bindElectronIpc"])
    expect(Object.keys(preload)).toEqual(["exposeElectronBridge"])
    expect(Object.keys(renderer).sort()).toEqual(["IpcTransportError", "makeElectronIpcClient"])
  }))
})
