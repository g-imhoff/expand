import { describe, expect, expectTypeOf, it } from "vitest"
import type { IpcBridgeOf } from "@expand/electron-ipc/contract"
import { exposeBridge, type PreloadIpcDeps } from "@expand/electron-ipc/preload"
import { ExpandIpc } from "@expand/desktop/shared/ipc/channels"

describe("ExpandIpc registry", () => {
  it("contains exactly the rpcPort portExchange channel", () => {
    expect(Object.keys(ExpandIpc.channels)).toEqual(["rpcPort"])
    expect(ExpandIpc.channels.rpcPort._kind).toBe("portExchange")
    expect(ExpandIpc.prefix).toBe("expand")
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
    exposeBridge(ExpandIpc, ExpandIpc.prefix, deps)
    expect(Object.keys(exposed)).toEqual([ExpandIpc.prefix])
    expect(Object.keys(exposed[ExpandIpc.prefix] as object).sort()).toEqual(Object.keys(ExpandIpc.channels).sort())
  })

  it("type-level surface ≡ derived bridge type (spec §10.2 pin)", () => {
    expectTypeOf<Window["expand"]>().toEqualTypeOf<IpcBridgeOf<typeof ExpandIpc>>()
  })
})
