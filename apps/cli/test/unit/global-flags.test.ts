import { describe, expect, it } from "vitest"
import { DataDir, Format, Quiet } from "@expand/cli/commands/global-flags"

describe("global flags", () => {
  it("Format, Quiet, and DataDir are global-flag settings", () => {
    expect(Format._tag).toBe("Setting")
    expect(Quiet._tag).toBe("Setting")
    expect(DataDir._tag).toBe("Setting")
    expect(DataDir.id).toBe("data-dir")
  })
})
