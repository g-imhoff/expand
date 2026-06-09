import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { Project, ProjectId, Tag } from "@yodea/contracts/project"

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

  it("ProjectId accepts a v4 UUID and rejects a name", () => {
    expect(Schema.decodeUnknownSync(ProjectId)("3f2504e0-4f89-41d3-9a0c-0305e82c3301")).toBeTypeOf("string")
    expect(() => Schema.decodeUnknownSync(ProjectId)("alpha")).toThrow()
  })

  it("Tag accepts kebab and rejects spaces/uppercase", () => {
    expect(Schema.decodeUnknownSync(Tag)("web-app")).toBe("web-app")
    expect(() => Schema.decodeUnknownSync(Tag)("Web App")).toThrow()
  })

  it("decodes a legacy project (no new fields) filling defaults", () => {
    const p = Schema.decodeUnknownSync(Project)({ id: "p1", name: "First", createdAt: "2026-01-01T00:00:00.000Z" })
    expect(p.directory).toBeNull()
    expect(p.description).toBeNull()
    expect(p.tags).toEqual([])
    expect(p.archived).toBe(false)
  })
})
