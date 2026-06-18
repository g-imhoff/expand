import { describe, expect, it } from "vitest"
import { channel } from "@yodea/contracts/channel"

describe("channel", () => {
  it("defaults to dev when __YODEA_CHANNEL__ is not baked in", () => {
    expect(channel).toBe("dev")
  })
})
