import { describe, expect, it } from "vitest"
import { YodeaRpcs } from "@yodea/contracts/rpc"

describe("YodeaRpcs contract", () => {
  it("is a defined RpcGroup", () => {
    expect(YodeaRpcs).toBeDefined()
  })
  it("exposes the five procedures by tag", () => {
    // RpcGroup exposes its requests; assert the tags we depend on exist.
    const tags = [...YodeaRpcs.requests.keys()]
    expect(tags).toEqual(
      expect.arrayContaining(["Health", "ProjectCreate", "ProjectList", "Connect", "Events"])
    )
  })
})
