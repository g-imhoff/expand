import { describe, expect, it } from "vitest"
import { newId } from "@expand/server/lib/ids"

describe("newId", () => {
  it("returns a uuid-shaped string", () => {
    expect(newId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })
  it("is unique across calls", () => {
    expect(newId()).not.toBe(newId())
  })
})
