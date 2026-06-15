import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { Project } from "@yodea/contracts/project"

const uid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

const valid = {
  id: uid(1),
  name: "my-app",
  directory: null,
  description: null,
  tags: [],
  archived: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
}

describe("Project schema", () => {
  it("decodes a well-formed project and brands its fields", () => {
    const p = Schema.decodeUnknownSync(Project)(valid)
    expect(p.id).toBe(uid(1))
    expect(p.name).toBe("my-app")
  })

  it("rejects an invalid id on decode", () => {
    expect(() => Schema.decodeUnknownSync(Project)({ ...valid, id: "p1" })).toThrow()
  })

  it("rejects a project missing a required field", () => {
    expect(() => Schema.decodeUnknownSync(Project)({ id: uid(1) })).toThrow()
  })

  it("decodes a legacy project (no new fields) filling defaults", () => {
    const p = Schema.decodeUnknownSync(Project)({ id: uid(1), name: "first", createdAt: "2026-01-01T00:00:00.000Z" })
    expect(p.directory).toBeNull()
    expect(p.description).toBeNull()
    expect(p.tags).toEqual([])
    expect(p.archived).toBe(false)
  })
})

describe("Project field validation (enforced by construction)", () => {
  const decode = (props: Record<string, unknown>) => Schema.decodeUnknownSync(Project)({ ...valid, ...props })

  it("accepts kebab names and rejects spaces/uppercase/empty", () => {
    expect(decode({ name: "my-app" }).name).toBe("my-app")
    expect(() => decode({ name: "My App" })).toThrow()
    expect(() => decode({ name: "" })).toThrow()
  })

  it("validates each tag", () => {
    expect(decode({ tags: ["web", "api"] }).tags).toEqual(["web", "api"])
    expect(() => decode({ tags: ["Bad Tag"] })).toThrow()
  })

  it("enforces the description length cap and accepts null", () => {
    expect(decode({ description: null }).description).toBeNull()
    expect(decode({ description: "ok" }).description).toBe("ok")
    expect(() => decode({ description: "x".repeat(2049) })).toThrow()
  })
})
