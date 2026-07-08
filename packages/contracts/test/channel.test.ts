import { describe, expect, it } from "vitest"
import { channel } from "@expand/contracts/channel"

describe("channel", () => {
  it("defaults to dev when __EXPAND_CHANNEL__ is not baked in", () => {
    expect(channel).toBe("dev")
  })
})
