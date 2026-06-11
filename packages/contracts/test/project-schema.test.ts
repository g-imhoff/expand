import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { Project, ProjectId, ProjectName, Tag } from "@yodea/contracts/project"

describe("Project opaque entity", () => {
  const uid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
  const valid = {
    id: ProjectId.make(uid(1)),
    name: ProjectName.make("my-app"),
    directory: null,
    description: null,
    tags: [],
    archived: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  }
  it("Project.make builds a branded value and validates fields", () => {
    const p = Project.make(valid)
    expect(p.id).toBe(uid(1))
    expect(() => Project.make({ ...valid, id: "p1" as ProjectId })).toThrow()
  })
  it("decode still applies field defaults", () => {
    const p = Schema.decodeUnknownSync(Project)({
      id: uid(1), name: "my-app", createdAt: "t"
    })
    expect(p.tags).toEqual([])
    expect(p.archived).toBe(false)
  })
})

describe("Project schema", () => {
  const uid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

  it("decodes a well-formed project", () => {
    const p = Schema.decodeUnknownSync(Project)({
      id: uid(1),
      name: "first",
      createdAt: "2026-01-01T00:00:00.000Z"
    })
    expect(p.id).toBe(uid(1))
  })

  it("rejects a project missing a field", () => {
    expect(() => Schema.decodeUnknownSync(Project)({ id: uid(1) })).toThrow()
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
    const p = Schema.decodeUnknownSync(Project)({ id: uid(1), name: "first", createdAt: "2026-01-01T00:00:00.000Z" })
    expect(p.directory).toBeNull()
    expect(p.description).toBeNull()
    expect(p.tags).toEqual([])
    expect(p.archived).toBe(false)
  })
})

describe("branded scalars", () => {
  it("ProjectId.make accepts a v4 UUID and rejects non-UUIDs", () => {
    const raw = "00000000-0000-4000-8000-000000000001"
    expect(ProjectId.make(raw)).toBe(raw)
    expect(() => ProjectId.make("p1")).toThrow()
  })
  it("ProjectName.make accepts kebab names and rejects uppercase", () => {
    expect(ProjectName.make("my-app")).toBe("my-app")
    expect(() => ProjectName.make("MyApp")).toThrow()
  })
  it("Tag.make enforces the tag pattern", () => {
    expect(Tag.make("backend")).toBe("backend")
    expect(() => Tag.make("-bad")).toThrow()
  })
})
