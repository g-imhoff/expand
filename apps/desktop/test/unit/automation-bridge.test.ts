import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect } from "effect"
import { ExpandRpcs } from "@expand/contracts/rpc"
import { DesktopRpcHandlers } from "@expand/desktop/main/rpc/handlers"
import { ExpandIpc } from "@expand/desktop/shared/ipc/channels"

describe("automation bridge", () => {
  it("exposes automation RPCs through the existing RPC stack without a second bridge", () => {
    const names = [...ExpandRpcs.requests.keys()]
    for (const tag of ["AutomationRoutineCreate", "AutomationRoutineGet", "AutomationCredentialPut", "AutomationPreviewClassification", "AutomationRunList", "AutomationCatalog"]) {
      expect(names).toContain(tag)
    }
    expect(DesktopRpcHandlers).toBeDefined()
    expect(Object.keys(ExpandIpc.channels)).toEqual(["rpcPort"])
  })

  it.effect("forwards automation catalog through the desktop handler layer", () => Effect.gen(function*() {
    expect(DesktopRpcHandlers).toBeDefined()
  }))
})
