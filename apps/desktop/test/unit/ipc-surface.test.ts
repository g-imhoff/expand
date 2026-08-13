import { describe, expect, expectTypeOf, it } from "vitest"
import { makeElectronIpcClient, type IpcClientOf } from "@expand/electron-ipc/renderer"
import { ExpandIpc } from "@expand/desktop/shared/ipc/channels"

describe("ExpandIpc registry", () => {
  it("contains exactly the rpcPort portExchange channel", () => {
    expect(Object.keys(ExpandIpc.channels)).toEqual(["rpcPort"])
    expect(ExpandIpc.channels.rpcPort._kind).toBe("portExchange")
    expect(ExpandIpc.prefix).toBe("expand")
  })

  it("derives the renderer client from the public facade", () => {
    const client = makeElectronIpcClient(ExpandIpc)
    expectTypeOf(client).toEqualTypeOf<IpcClientOf<typeof ExpandIpc>>()
  })
})
