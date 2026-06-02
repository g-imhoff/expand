import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { DomainEventFromJson, ProjectCreated, ProjectRenamed } from "@yodea/contracts/events"

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
    // `directory` is omitted on encode (optionalKey) and decodes back to the
    // null default — the roundtrip materializes the additive field.
    expect(Schema.decodeUnknownSync(DomainEventFromJson)(json)).toEqual({ ...e, directory: null })
  })

  it("decodes a legacy ProjectCreated JSON without directory to directory:null", () => {
    const legacy = JSON.stringify({ _tag: "ProjectCreated", projectId: "p1", name: "First", createdAt: "2026-01-01T00:00:00.000Z" })
    const decoded = Schema.decodeUnknownSync(DomainEventFromJson)(legacy)
    expect(decoded._tag).toBe("ProjectCreated")
    expect((decoded as { directory: string | null }).directory).toBeNull()
  })

  it("roundtrips ProjectCreated WITH a directory", () => {
    const e = ProjectCreated.make({ projectId: "p1", name: "First", directory: "/tmp/x", createdAt: "t" })
    expect(Schema.decodeUnknownSync(DomainEventFromJson)(Schema.encodeSync(DomainEventFromJson)(e))).toEqual(e)
  })
})

describe("ProjectRenamed", () => {
  it("constructs with an auto-filled _tag", () => {
    const e = ProjectRenamed.make({ projectId: "p1", name: "Renamed", occurredAt: "2026-01-02T00:00:00.000Z" })
    expect(e._tag).toBe("ProjectRenamed")
    expect(e.name).toBe("Renamed")
  })
  it("roundtrips through the DomainEvent JSON codec", () => {
    const e = ProjectRenamed.make({ projectId: "p1", name: "Renamed", occurredAt: "2026-01-02T00:00:00.000Z" })
    const json = Schema.encodeSync(DomainEventFromJson)(e)
    expect(typeof json).toBe("string")
    expect(Schema.decodeUnknownSync(DomainEventFromJson)(json)).toEqual(e)
  })
})
