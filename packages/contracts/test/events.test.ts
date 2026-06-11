import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { DomainEventFromJson, SequencedEvent } from "@yodea/contracts/events/domain"
import { ProjectArchived, ProjectCreated, ProjectDeleted, ProjectDirectoryChanged, ProjectMetadataChanged, ProjectRenamed, ProjectRestored } from "@yodea/contracts/events/project"
import { ProjectId, ProjectName, Tag } from "@yodea/contracts/project"

const uid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const pid1 = ProjectId.make(uid(1))
const nameA = ProjectName.make("a")
const nameRenamed = ProjectName.make("renamed")
const tagAlpha = Tag.make("alpha")
const tagBeta = Tag.make("beta")
const tagX = Tag.make("x")

describe("DomainEvent", () => {
  it("constructs ProjectCreated with an auto-filled _tag", () => {
    const e = ProjectCreated.make({
      projectId: pid1,
      name: nameA,
      occurredAt: "2026-01-01T00:00:00.000Z"
    })
    expect(e._tag).toBe("ProjectCreated")
    expect(e.name).toBe("a")
  })

  it("roundtrips through JSON text", () => {
    const e = ProjectCreated.make({
      projectId: pid1,
      name: nameA,
      occurredAt: "2026-01-01T00:00:00.000Z"
    })
    const json = Schema.encodeSync(DomainEventFromJson)(e)
    expect(typeof json).toBe("string")
    expect(Schema.decodeUnknownSync(DomainEventFromJson)(json)).toEqual({ ...e, directory: null })
  })

  it("decodes a legacy ProjectCreated JSON without directory to directory:null", () => {
    const legacy = JSON.stringify({ _tag: "ProjectCreated", projectId: uid(1), name: "a", occurredAt: "2026-01-01T00:00:00.000Z" })
    const decoded = Schema.decodeUnknownSync(DomainEventFromJson)(legacy)
    expect(decoded._tag).toBe("ProjectCreated")
    expect((decoded as { directory: string | null }).directory).toBeNull()
  })

  it("roundtrips ProjectCreated WITH a directory", () => {
    const e = ProjectCreated.make({ projectId: pid1, name: nameA, directory: "/tmp/x", occurredAt: "t" })
    expect(Schema.decodeUnknownSync(DomainEventFromJson)(Schema.encodeSync(DomainEventFromJson)(e))).toEqual(e)
  })
})

describe("ProjectRenamed", () => {
  it("constructs with an auto-filled _tag", () => {
    const e = ProjectRenamed.make({ projectId: pid1, name: nameRenamed, occurredAt: "2026-01-02T00:00:00.000Z" })
    expect(e._tag).toBe("ProjectRenamed")
    expect(e.name).toBe("renamed")
  })
  it("roundtrips through the DomainEvent JSON codec", () => {
    const e = ProjectRenamed.make({ projectId: pid1, name: nameRenamed, occurredAt: "2026-01-02T00:00:00.000Z" })
    const json = Schema.encodeSync(DomainEventFromJson)(e)
    expect(typeof json).toBe("string")
    expect(Schema.decodeUnknownSync(DomainEventFromJson)(json)).toEqual(e)
  })
})

describe("ProjectDirectoryChanged", () => {
  it("constructs with an auto-filled _tag", () => {
    const e = ProjectDirectoryChanged.make({
      projectId: pid1,
      directory: "/home/u/p1",
      occurredAt: "2026-01-02T00:00:00.000Z"
    })
    expect(e._tag).toBe("ProjectDirectoryChanged")
    expect(e.directory).toBe("/home/u/p1")
  })
  it("roundtrips through JSON text", () => {
    const e = ProjectDirectoryChanged.make({
      projectId: pid1,
      directory: "/home/u/p1",
      occurredAt: "2026-01-02T00:00:00.000Z"
    })
    const json = Schema.encodeSync(DomainEventFromJson)(e)
    expect(Schema.decodeUnknownSync(DomainEventFromJson)(json)).toEqual(e)
  })
})

describe("ProjectArchived / ProjectRestored", () => {
  it("constructs ProjectArchived with an auto-filled _tag", () => {
    const e = ProjectArchived.make({ projectId: pid1, occurredAt: "2026-06-02T00:00:00.000Z" })
    expect(e._tag).toBe("ProjectArchived")
    expect(e.projectId).toBe(uid(1))
  })
  it("roundtrips ProjectArchived through JSON text", () => {
    const e = ProjectArchived.make({ projectId: pid1, occurredAt: "2026-06-02T00:00:00.000Z" })
    const json = Schema.encodeSync(DomainEventFromJson)(e)
    expect(Schema.decodeUnknownSync(DomainEventFromJson)(json)).toEqual(e)
  })
  it("roundtrips ProjectRestored through JSON text", () => {
    const e = ProjectRestored.make({ projectId: pid1, occurredAt: "2026-06-02T00:00:00.000Z" })
    const json = Schema.encodeSync(DomainEventFromJson)(e)
    expect(Schema.decodeUnknownSync(DomainEventFromJson)(json)).toEqual(e)
  })
})

describe("ProjectMetadataChanged", () => {
  it("constructs with optional description + tags and an auto-filled _tag", () => {
    const e = ProjectMetadataChanged.make({
      projectId: pid1,
      description: "a project",
      tags: [tagAlpha, tagBeta] as ReadonlyArray<Tag>,
      occurredAt: "2026-01-02T00:00:00.000Z"
    })
    expect(e._tag).toBe("ProjectMetadataChanged")
    expect(e.description).toBe("a project")
    expect(e.tags).toEqual(["alpha", "beta"])
  })

  it("roundtrips through JSON text with only description present", () => {
    const e = ProjectMetadataChanged.make({
      projectId: pid1,
      description: null,
      occurredAt: "2026-01-02T00:00:00.000Z"
    })
    const json = Schema.encodeSync(DomainEventFromJson)(e)
    expect(Schema.decodeUnknownSync(DomainEventFromJson)(json)).toEqual(e)
  })

  it("roundtrips through the DomainEvent union with only tags present", () => {
    const e = ProjectMetadataChanged.make({
      projectId: pid1,
      tags: [tagX] as ReadonlyArray<Tag>,
      occurredAt: "2026-01-02T00:00:00.000Z"
    })
    const json = Schema.encodeSync(DomainEventFromJson)(e)
    expect(Schema.decodeUnknownSync(DomainEventFromJson)(json)).toEqual(e)
  })
})

describe("ProjectDeleted", () => {
  it("constructs with an auto-filled _tag", () => {
    const e = ProjectDeleted.make({ projectId: pid1, occurredAt: "2026-06-02T00:00:00.000Z" })
    expect(e._tag).toBe("ProjectDeleted")
    expect(e.projectId).toBe(uid(1))
  })
  it("roundtrips through JSON text via the union codec", () => {
    const e = ProjectDeleted.make({ projectId: pid1, occurredAt: "2026-06-02T00:00:00.000Z" })
    const json = Schema.encodeSync(DomainEventFromJson)(e)
    expect(typeof json).toBe("string")
    expect(Schema.decodeUnknownSync(DomainEventFromJson)(json)).toEqual(e)
  })
})

describe("SequencedEvent", () => {
  it("decodes a { seq, event } envelope and rejects a non-integer seq", () => {
    const decoded = Schema.decodeUnknownSync(SequencedEvent)({
      seq: 7,
      event: { _tag: "ProjectCreated", projectId: uid(1), name: "a", directory: null, occurredAt: "t1" }
    })
    expect(decoded.seq).toBe(7)
    expect(decoded.event._tag).toBe("ProjectCreated")
    expect(() =>
      Schema.decodeUnknownSync(SequencedEvent)({
        seq: 1.5,
        event: { _tag: "ProjectDeleted", projectId: uid(1), occurredAt: "t1" }
      })
    ).toThrow()
  })
})

describe("ProjectCreated branded fields", () => {
  it("ProjectCreated.make rejects non-UUID projectId and invalid name", () => {
    const uuid = "00000000-0000-4000-8000-000000000001"
    expect(() => ProjectCreated.make({ projectId: "p1" as ProjectId, name: "a" as ProjectName, occurredAt: "t" })).toThrow()
    expect(() => ProjectCreated.make({ projectId: uuid as ProjectId, name: "Bad Name" as ProjectName, occurredAt: "t" })).toThrow()
    const ok = ProjectCreated.make({ projectId: uuid as ProjectId, name: "a" as ProjectName, occurredAt: "t" })
    expect(ok.projectId).toBe(uuid)
  })
})
