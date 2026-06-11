import { describe, expect, expectTypeOf, it } from "vitest"
import type { IpcBridgeOf } from "@yodea/electron-ipc/contract"
import { exposeBridge, type PreloadIpcDeps } from "@yodea/electron-ipc/preload"
import { YodeaIpc } from "@yodea/desktop/shared/ipc/channels"

describe("YodeaIpc registry", () => {
  it("contains exactly the rpcPort portExchange channel", () => {
    expect(Object.keys(YodeaIpc.channels)).toEqual(["rpcPort"])
    expect(YodeaIpc.channels.rpcPort._kind).toBe("portExchange")
    expect(YodeaIpc.prefix).toBe("yodea")
  })

  it("runtime surface ≡ registry keys (spec §10.2 pin)", () => {
    const exposed: Record<string, unknown> = {}
    const deps: PreloadIpcDeps = {
      send: () => {},
      invoke: () => Promise.resolve(undefined),
      on: () => () => {},
      exposeInMainWorld: (key, api) => {
        exposed[key] = api
      },
      postToMainWorld: () => {}
    }
    exposeBridge(YodeaIpc, "yodea", deps)
    expect(Object.keys(exposed)).toEqual(["yodea"])
    expect(Object.keys(exposed["yodea"] as object).sort()).toEqual(Object.keys(YodeaIpc.channels).sort())
  })

  it("type-level surface ≡ derived bridge type (spec §10.2 pin)", () => {
    expectTypeOf<Window["yodea"]>().toEqualTypeOf<IpcBridgeOf<typeof YodeaIpc>>()
  })
})
