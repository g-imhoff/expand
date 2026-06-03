import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { DomainEventFromJson } from "@yodea/contracts/events/domain"
import { ProjectArchived, ProjectCreated, ProjectDeleted, ProjectDirectoryChanged, ProjectMetadataChanged, ProjectRenamed, ProjectRestored } from "@yodea/contracts/events/project"

describe("DomainEvent", () => {
  it("constructs ProjectCreated with an auto-filled _tag", () => {
    const e = ProjectCreated.make({
      projectId: "p1",
      name: "First",
      occurredAt: "2026-01-01T00:00:00.000Z"
    })
    expect(e._tag).toBe("ProjectCreated")
    expect(e.name).toBe("First")
  })

  it("roundtrips through JSON text", () => {
    const e = ProjectCreated.make({
      projectId: "p1",
      name: "First",
      occurredAt: "2026-01-01T00:00:00.000Z"
    })
    const json = Schema.encodeSync(DomainEventFromJson)(e)
    expect(typeof json).toBe("string")
    expect(Schema.decodeUnknownSync(DomainEventFromJson)(json)).toEqual({ ...e, directory: null })
  })

  it("decodes a legacy ProjectCreated JSON without directory to directory:null", () => {
    const legacy = JSON.stringify({ _tag: "ProjectCreated", projectId: "p1", name: "First", occurredAt: "2026-01-01T00:00:00.000Z" })
    const decoded = Schema.decodeUnknownSync(DomainEventFromJson)(legacy)
    expect(decoded._tag).toBe("ProjectCreated")
    expect((decoded as { directory: string | null }).directory).toBeNull()
  })

  it("roundtrips ProjectCreated WITH a directory", () => {
    const e = ProjectCreated.make({ projectId: "p1", name: "First", directory: "/tmp/x", occurredAt: "t" })
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

describe("ProjectDirectoryChanged", () => {
  it("constructs with an auto-filled _tag", () => {
    const e = ProjectDirectoryChanged.make({
      projectId: "p1",
      directory: "/home/u/p1",
      occurredAt: "2026-01-02T00:00:00.000Z"
    })
    expect(e._tag).toBe("ProjectDirectoryChanged")
    expect(e.directory).toBe("/home/u/p1")
  })
  it("roundtrips through JSON text", () => {
    const e = ProjectDirectoryChanged.make({
      projectId: "p1",
      directory: "/home/u/p1",
      occurredAt: "2026-01-02T00:00:00.000Z"
    })
    const json = Schema.encodeSync(DomainEventFromJson)(e)
    expect(Schema.decodeUnknownSync(DomainEventFromJson)(json)).toEqual(e)
  })
})

describe("ProjectArchived / ProjectRestored", () => {
  it("constructs ProjectArchived with an auto-filled _tag", () => {
    const e = ProjectArchived.make({ projectId: "p1", occurredAt: "2026-06-02T00:00:00.000Z" })
    expect(e._tag).toBe("ProjectArchived")
    expect(e.projectId).toBe("p1")
  })
  it("roundtrips ProjectArchived through JSON text", () => {
    const e = ProjectArchived.make({ projectId: "p1", occurredAt: "2026-06-02T00:00:00.000Z" })
    const json = Schema.encodeSync(DomainEventFromJson)(e)
    expect(Schema.decodeUnknownSync(DomainEventFromJson)(json)).toEqual(e)
  })
  it("roundtrips ProjectRestored through JSON text", () => {
    const e = ProjectRestored.make({ projectId: "p1", occurredAt: "2026-06-02T00:00:00.000Z" })
    const json = Schema.encodeSync(DomainEventFromJson)(e)
    expect(Schema.decodeUnknownSync(DomainEventFromJson)(json)).toEqual(e)
  })
})

describe("ProjectMetadataChanged", () => {
  it("constructs with optional description + tags and an auto-filled _tag", () => {
    const e = ProjectMetadataChanged.make({
      projectId: "p1",
      description: "a project",
      tags: ["alpha", "beta"],
      occurredAt: "2026-01-02T00:00:00.000Z"
    })
    expect(e._tag).toBe("ProjectMetadataChanged")
    expect(e.description).toBe("a project")
    expect(e.tags).toEqual(["alpha", "beta"])
  })

  it("roundtrips through JSON text with only description present", () => {
    const e = ProjectMetadataChanged.make({
      projectId: "p1",
      description: null,
      occurredAt: "2026-01-02T00:00:00.000Z"
    })
    const json = Schema.encodeSync(DomainEventFromJson)(e)
    expect(Schema.decodeUnknownSync(DomainEventFromJson)(json)).toEqual(e)
  })

  it("roundtrips through the DomainEvent union with only tags present", () => {
    const e = ProjectMetadataChanged.make({
      projectId: "p1",
      tags: ["x"],
      occurredAt: "2026-01-02T00:00:00.000Z"
    })
    const json = Schema.encodeSync(DomainEventFromJson)(e)
    expect(Schema.decodeUnknownSync(DomainEventFromJson)(json)).toEqual(e)
  })
})

describe("ProjectDeleted", () => {
  it("constructs with an auto-filled _tag", () => {
    const e = ProjectDeleted.make({ projectId: "p1", occurredAt: "2026-06-02T00:00:00.000Z" })
    expect(e._tag).toBe("ProjectDeleted")
    expect(e.projectId).toBe("p1")
  })
  it("roundtrips through JSON text via the union codec", () => {
    const e = ProjectDeleted.make({ projectId: "p1", occurredAt: "2026-06-02T00:00:00.000Z" })
    const json = Schema.encodeSync(DomainEventFromJson)(e)
    expect(typeof json).toBe("string")
    expect(Schema.decodeUnknownSync(DomainEventFromJson)(json)).toEqual(e)
  })
})
