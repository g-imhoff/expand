import { describe, expect, it } from "vitest"
import * as fc from "fast-check"
import { projectsFromEvents } from "@yodea/domain/project"
import {
  ProjectArchived,
  ProjectCreated,
  ProjectDeleted,
  ProjectDirectoryChanged,
  ProjectMetadataChanged,
  ProjectRenamed,
  ProjectRestored
} from "@yodea/contracts/events"
import type { DomainEvent } from "@yodea/contracts/events"

const idArb = fc.constantFrom("p1", "p2", "p3", "p4")
const nameArb = fc.constantFrom("alpha", "beta", "gamma", "delta")
const tsArb = fc.integer({ min: 1, max: 9999 }).map((n) => `t${String(n).padStart(4, "0")}`)

const eventArb: fc.Arbitrary<DomainEvent> = fc.oneof(
  fc.record({ projectId: idArb, name: nameArb, createdAt: tsArb }).map((r) => ProjectCreated.make(r)),
  fc.record({ projectId: idArb, name: nameArb, occurredAt: tsArb }).map((r) => ProjectRenamed.make(r)),
  fc.record({ projectId: idArb, directory: fc.constantFrom("/a", "/b"), occurredAt: tsArb }).map((r) => ProjectDirectoryChanged.make(r)),
  fc.record({ projectId: idArb, occurredAt: tsArb }).map((r) => ProjectArchived.make(r)),
  fc.record({ projectId: idArb, occurredAt: tsArb }).map((r) => ProjectRestored.make(r)),
  fc.record({ projectId: idArb, tags: fc.array(fc.constantFrom("x", "y", "z")), occurredAt: tsArb }).map((r) => ProjectMetadataChanged.make(r)),
  fc.record({ projectId: idArb, occurredAt: tsArb }).map((r) => ProjectDeleted.make(r))
)
const logArb = fc.array(eventArb, { maxLength: 30 })

describe("projectsFromEvents — properties", () => {
  it("is deterministic: same log -> same read-model", () => {
    fc.assert(fc.property(logArb, (log) => {
      expect(projectsFromEvents(log)).toEqual(projectsFromEvents([...log]))
    }))
  })

  it("is idempotent under event duplication (replay-safe): doubling every event leaves the model unchanged", () => {
    fc.assert(fc.property(logArb, (log) => {
      const doubled = log.flatMap((e) => [e, e])
      expect(projectsFromEvents(doubled)).toEqual(projectsFromEvents(log))
    }))
  })

  it("a tombstoned id never appears, even if mutated afterwards", () => {
    fc.assert(fc.property(logArb, idArb, tsArb, (log, id, ts) => {
      const withDelete = [
        ProjectCreated.make({ projectId: id, name: "alpha", createdAt: "t0001" }),
        ...log,
        ProjectDeleted.make({ projectId: id, occurredAt: ts }),
        ProjectRenamed.make({ projectId: id, name: "beta", occurredAt: `${ts}z` })
      ]
      expect(projectsFromEvents(withDelete).some((p) => p.id === id)).toBe(false)
    }))
  })

  it("every surviving project has a stable createdAt and a non-empty id from a create", () => {
    fc.assert(fc.property(logArb, (log) => {
      const created = new Set(log.filter((e) => e._tag === "ProjectCreated").map((e) => e.projectId))
      for (const p of projectsFromEvents(log)) {
        expect(created.has(p.id)).toBe(true)
        expect(typeof p.createdAt).toBe("string")
        expect(p.createdAt.length).toBeGreaterThan(0)
      }
    }))
  })

  it("output ids are unique (the fold never duplicates an aggregate)", () => {
    fc.assert(fc.property(logArb, (log) => {
      const ids = projectsFromEvents(log).map((p) => p.id)
      expect(new Set(ids).size).toBe(ids.length)
    }))
  })
})
