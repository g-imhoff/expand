import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect, Result, Schema } from "effect"
import { DomainEventFromJson, SequencedEvent } from "@expand/contracts/events/domain"
import { ProjectArchived, ProjectCreated, ProjectDeleted, ProjectDirectoryChanged, ProjectMetadataChanged, ProjectRenamed, ProjectRestored } from "@expand/contracts/events/project"

const uid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const pid1 = uid(1)
const nameA = "a"
const nameRenamed = "renamed"
const tagAlpha = "alpha"
const tagBeta = "beta"
const tagX = "x"

const LegacyProjectCreatedFromJson = Schema.fromJsonString(Schema.Struct({
  _tag: Schema.Literal("ProjectCreated"),
  projectId: Schema.String,
  name: Schema.String,
  occurredAt: Schema.String
}))

describe("DomainEvent", () => {
  it.effect("constructs ProjectCreated with an auto-filled _tag", () => Effect.gen(function*() {
    const e = ProjectCreated.make({
      projectId: pid1,
      name: nameA,
      occurredAt: "2026-01-01T00:00:00.000Z"
    })
    expect(e._tag).toBe("ProjectCreated")
    expect(e.name).toBe("a")
  }))

  it.effect("roundtrips through JSON text", () => Effect.gen(function*() {
    const e = ProjectCreated.make({
      projectId: pid1,
      name: nameA,
      occurredAt: "2026-01-01T00:00:00.000Z"
    })
    const json = yield* Schema.encodeEffect(DomainEventFromJson)(e)
    expect(typeof json).toBe("string")
    expect(yield* Schema.decodeUnknownEffect(DomainEventFromJson)(json)).toEqual({ ...e, directory: null })
  }))

  it.effect("decodes a legacy ProjectCreated JSON without directory to directory:null", () => Effect.gen(function*() {
    const legacy = yield* Schema.encodeEffect(LegacyProjectCreatedFromJson)({
      _tag: "ProjectCreated",
      projectId: uid(1),
      name: "a",
      occurredAt: "2026-01-01T00:00:00.000Z"
    })
    const decoded = yield* Schema.decodeUnknownEffect(DomainEventFromJson)(legacy)
    expect(decoded._tag).toBe("ProjectCreated")
    expect((decoded as { directory: string | null }).directory).toBeNull()
  }))

  it.effect("roundtrips ProjectCreated WITH a directory", () => Effect.gen(function*() {
    const e = ProjectCreated.make({ projectId: pid1, name: nameA, directory: "/tmp/x", occurredAt: "t" })
    const encoded = yield* Schema.encodeEffect(DomainEventFromJson)(e)
    expect(yield* Schema.decodeUnknownEffect(DomainEventFromJson)(encoded)).toEqual(e)
  }))
})

describe("ProjectRenamed", () => {
  it.effect("constructs with an auto-filled _tag", () => Effect.gen(function*() {
    const e = ProjectRenamed.make({ projectId: pid1, name: nameRenamed, occurredAt: "2026-01-02T00:00:00.000Z" })
    expect(e._tag).toBe("ProjectRenamed")
    expect(e.name).toBe("renamed")
  }))
  it.effect("roundtrips through the DomainEvent JSON codec", () => Effect.gen(function*() {
    const e = ProjectRenamed.make({ projectId: pid1, name: nameRenamed, occurredAt: "2026-01-02T00:00:00.000Z" })
    const json = yield* Schema.encodeEffect(DomainEventFromJson)(e)
    expect(typeof json).toBe("string")
    expect(yield* Schema.decodeUnknownEffect(DomainEventFromJson)(json)).toEqual(e)
  }))
})

describe("ProjectDirectoryChanged", () => {
  it.effect("constructs with an auto-filled _tag", () => Effect.gen(function*() {
    const e = ProjectDirectoryChanged.make({
      projectId: pid1,
      directory: "/home/u/p1",
      occurredAt: "2026-01-02T00:00:00.000Z"
    })
    expect(e._tag).toBe("ProjectDirectoryChanged")
    expect(e.directory).toBe("/home/u/p1")
  }))
  it.effect("roundtrips through JSON text", () => Effect.gen(function*() {
    const e = ProjectDirectoryChanged.make({
      projectId: pid1,
      directory: "/home/u/p1",
      occurredAt: "2026-01-02T00:00:00.000Z"
    })
    const json = yield* Schema.encodeEffect(DomainEventFromJson)(e)
    expect(yield* Schema.decodeUnknownEffect(DomainEventFromJson)(json)).toEqual(e)
  }))
})

describe("ProjectArchived / ProjectRestored", () => {
  it.effect("constructs ProjectArchived with an auto-filled _tag", () => Effect.gen(function*() {
    const e = ProjectArchived.make({ projectId: pid1, occurredAt: "2026-06-02T00:00:00.000Z" })
    expect(e._tag).toBe("ProjectArchived")
    expect(e.projectId).toBe(uid(1))
  }))
  it.effect("roundtrips ProjectArchived through JSON text", () => Effect.gen(function*() {
    const e = ProjectArchived.make({ projectId: pid1, occurredAt: "2026-06-02T00:00:00.000Z" })
    const json = yield* Schema.encodeEffect(DomainEventFromJson)(e)
    expect(yield* Schema.decodeUnknownEffect(DomainEventFromJson)(json)).toEqual(e)
  }))
  it.effect("roundtrips ProjectRestored through JSON text", () => Effect.gen(function*() {
    const e = ProjectRestored.make({ projectId: pid1, occurredAt: "2026-06-02T00:00:00.000Z" })
    const json = yield* Schema.encodeEffect(DomainEventFromJson)(e)
    expect(yield* Schema.decodeUnknownEffect(DomainEventFromJson)(json)).toEqual(e)
  }))
})

describe("ProjectMetadataChanged", () => {
  it.effect("constructs with optional description + tags and an auto-filled _tag", () => Effect.gen(function*() {
    const e = ProjectMetadataChanged.make({
      projectId: pid1,
      description: "a project",
      tags: [tagAlpha, tagBeta] as ReadonlyArray<string>,
      occurredAt: "2026-01-02T00:00:00.000Z"
    })
    expect(e._tag).toBe("ProjectMetadataChanged")
    expect(e.description).toBe("a project")
    expect(e.tags).toEqual(["alpha", "beta"])
  }))

  it.effect("roundtrips through JSON text with only description present", () => Effect.gen(function*() {
    const e = ProjectMetadataChanged.make({
      projectId: pid1,
      description: null,
      occurredAt: "2026-01-02T00:00:00.000Z"
    })
    const json = yield* Schema.encodeEffect(DomainEventFromJson)(e)
    expect(yield* Schema.decodeUnknownEffect(DomainEventFromJson)(json)).toEqual(e)
  }))

  it.effect("roundtrips through the DomainEvent union with only tags present", () => Effect.gen(function*() {
    const e = ProjectMetadataChanged.make({
      projectId: pid1,
      tags: [tagX] as ReadonlyArray<string>,
      occurredAt: "2026-01-02T00:00:00.000Z"
    })
    const json = yield* Schema.encodeEffect(DomainEventFromJson)(e)
    expect(yield* Schema.decodeUnknownEffect(DomainEventFromJson)(json)).toEqual(e)
  }))
})

describe("ProjectDeleted", () => {
  it.effect("constructs with an auto-filled _tag", () => Effect.gen(function*() {
    const e = ProjectDeleted.make({ projectId: pid1, occurredAt: "2026-06-02T00:00:00.000Z" })
    expect(e._tag).toBe("ProjectDeleted")
    expect(e.projectId).toBe(uid(1))
  }))
  it.effect("roundtrips through JSON text via the union codec", () => Effect.gen(function*() {
    const e = ProjectDeleted.make({ projectId: pid1, occurredAt: "2026-06-02T00:00:00.000Z" })
    const json = yield* Schema.encodeEffect(DomainEventFromJson)(e)
    expect(typeof json).toBe("string")
    expect(yield* Schema.decodeUnknownEffect(DomainEventFromJson)(json)).toEqual(e)
  }))
})

describe("SequencedEvent", () => {
  it.effect("decodes a { seq, event } envelope and rejects a non-integer seq", () => Effect.gen(function*() {
    const decoded = yield* Schema.decodeUnknownEffect(SequencedEvent)({
      seq: 7,
      event: { _tag: "ProjectCreated", projectId: uid(1), name: "a", directory: null, occurredAt: "t1" }
    })
    expect(decoded.seq).toBe(7)
    expect(decoded.event._tag).toBe("ProjectCreated")
    const invalid = yield* Schema.decodeUnknownEffect(SequencedEvent)({
      seq: 1.5,
      event: { _tag: "ProjectDeleted", projectId: uid(1), occurredAt: "t1" }
    }).pipe(Effect.result)
    expect(Result.isFailure(invalid)).toBe(true)
  }))
})

describe("ProjectCreated plain-string fields", () => {
  it.effect("carries projectId/name as plain strings (events are validated at ingestion, not here)", () => Effect.gen(function*() {
    const uuid = "00000000-0000-4000-8000-000000000001"
    // The event schema no longer brands or validates — the server's Project verbs
    // do that before an event is appended, so the event accepts raw strings.
    const e = ProjectCreated.make({ projectId: uuid, name: "a", occurredAt: "t" })
    expect(e.projectId).toBe(uuid)
    expect(e.name).toBe("a")
  }))
})
