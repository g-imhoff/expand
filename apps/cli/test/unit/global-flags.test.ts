import { describe, expect, it } from "vitest"
import { Format, Quiet } from "@yodea/cli/global-flags"

describe("global flags", () => {
  it("Format and Quiet are global-flag settings", () => {
    expect(Format._tag).toBe("Setting")
    expect(Quiet._tag).toBe("Setting")
  })
})
