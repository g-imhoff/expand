import { describe, expect, it } from "vitest"
import * as fc from "fast-check"
import { projectsFromEvents } from "@yodea/server/domain/project"
import {
  ProjectArchived,
  ProjectCreated,
  ProjectDeleted,
  ProjectDirectoryChanged,
  ProjectMetadataChanged,
  ProjectRenamed,
  ProjectRestored
} from "@yodea/contracts/events/project"
import type { DomainEvent } from "@yodea/contracts/events/domain"

const nameArb = fc.constantFrom("alpha", "beta", "gamma")
const tsArb = fc.integer({ min: 1, max: 9999 }).map((n) => `t${String(n).padStart(4, "0")}`)

function eventArbFor(idArb: fc.Arbitrary<string>): fc.Arbitrary<DomainEvent> {
  return fc.oneof(
    fc.record({ projectId: idArb, name: nameArb, occurredAt: tsArb }).map((r) => ProjectCreated.make({ ...r, projectId: r.projectId, name: r.name })),
    fc.record({ projectId: idArb, name: nameArb, occurredAt: tsArb }).map((r) => ProjectRenamed.make({ ...r, projectId: r.projectId, name: r.name })),
    fc.record({ projectId: idArb, directory: fc.constantFrom("/a", "/b"), occurredAt: tsArb }).map((r) => ProjectDirectoryChanged.make({ ...r, projectId: r.projectId })),
    fc.record({ projectId: idArb, occurredAt: tsArb }).map((r) => ProjectArchived.make({ ...r, projectId: r.projectId })),
    fc.record({ projectId: idArb, occurredAt: tsArb }).map((r) => ProjectRestored.make({ ...r, projectId: r.projectId })),
    fc.record({ projectId: idArb, tags: fc.array(fc.constantFrom("x", "y", "z")).map((ts) => ts.map((t) => t)), occurredAt: tsArb }).map((r) => ProjectMetadataChanged.make({ ...r, projectId: r.projectId })),
    fc.record({ projectId: idArb, occurredAt: tsArb }).map((r) => ProjectDeleted.make({ ...r, projectId: r.projectId }))
  )
}

// Draw a small per-run pool of distinct v4 UUIDs so events in the same log
// share aggregate ids, exercising the default → Project.applyEvent branch.
const logArb = fc
  .uniqueArray(fc.uuid({ version: 4 }), { minLength: 1, maxLength: 4 })
  .chain((pool) =>
    fc.array(eventArbFor(fc.constantFrom(...pool)), { minLength: 0, maxLength: 30 })
  )

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
    // Draw the id from the same pool so the interior log can hit the same aggregate
    const tombstoneArb = fc
      .uniqueArray(fc.uuid({ version: 4 }), { minLength: 1, maxLength: 4 })
      .chain((pool) =>
        fc.tuple(
          fc.array(eventArbFor(fc.constantFrom(...pool)), { minLength: 0, maxLength: 30 }),
          fc.constantFrom(...pool),
          tsArb
        )
      )
    fc.assert(fc.property(tombstoneArb, ([log, id, ts]) => {
      const pid = id
      const withDelete = [
        ProjectCreated.make({ projectId: pid, name: "alpha", occurredAt: "t0001" }),
        ...log,
        ProjectDeleted.make({ projectId: pid, occurredAt: ts }),
        ProjectRenamed.make({ projectId: pid, name: "beta", occurredAt: `${ts}z` })
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

  it("mutations are applied: archiving an existing project sets archived:true", () => {
    // Draw a single id from the pool; guarantee create then archive in that order.
    const archiveArb = fc
      .uniqueArray(fc.uuid({ version: 4 }), { minLength: 1, maxLength: 4 })
      .chain((pool) =>
        fc.tuple(
          fc.constantFrom(...pool),
          tsArb,
          tsArb
        )
      )
    fc.assert(fc.property(archiveArb, ([id, t1, t2]) => {
      const projId = id
      const log = [
        ProjectCreated.make({ projectId: projId, name: "alpha", occurredAt: t1 < t2 ? t1 : t2 }),
        ProjectArchived.make({ projectId: projId, occurredAt: t1 < t2 ? t2 : t1 })
      ]
      const result = projectsFromEvents(log)
      expect(result).toHaveLength(1)
      expect(result[0]?.archived).toBe(true)
    }))
  })
})
