import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { DomainEventFromJson, ProjectCreated } from "@yodea/shared/events"

describe("DomainEvent", () => {
  it("constructs ProjectCreated with an auto-filled _tag", () => {
    const e = ProjectCreated.make({
      projectId: "p1",
      name: "First",
      createdAt: "2026-01-01T00:00:00.000Z"
    })
    expect(e._tag).toBe("ProjectCreated")
    expect(e.name).toBe("First")
  })

  it("roundtrips through JSON text", () => {
    const e = ProjectCreated.make({
      projectId: "p1",
      name: "First",
      createdAt: "2026-01-01T00:00:00.000Z"
    })
    const json = Schema.encodeSync(DomainEventFromJson)(e)
    expect(typeof json).toBe("string")
    expect(Schema.decodeUnknownSync(DomainEventFromJson)(json)).toEqual(e)
  })
})
