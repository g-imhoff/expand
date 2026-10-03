import { describe, expect, it } from "vitest"
import { isExecutableStatus } from "@expand/server/automation/routine-service"

describe("routine execution gate", () => {
  it("runs only enabled routines", () => {
    expect(isExecutableStatus("enabled")).toBe(true)
    expect(isExecutableStatus("paused")).toBe(false)
    expect(isExecutableStatus("deleted")).toBe(false)
  })
})
