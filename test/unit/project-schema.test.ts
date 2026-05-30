import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { Project } from "@yodea/contracts/project"

describe("Project schema", () => {
  it("decodes a well-formed project", () => {
    const p = Schema.decodeUnknownSync(Project)({
      id: "p1",
      name: "First",
      createdAt: "2026-01-01T00:00:00.000Z"
    })
    expect(p.id).toBe("p1")
  })

  it("rejects a project missing a field", () => {
    expect(() => Schema.decodeUnknownSync(Project)({ id: "p1" })).toThrow()
  })
})
