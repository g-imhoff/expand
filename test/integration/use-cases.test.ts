import { describe, expect, it } from "vitest"
import { Effect, Layer, PubSub } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventStore, EventStoreLayer } from "@yodea/db/event-store"
import { EventBus, EventBusLayer } from "@yodea/application/event-bus"
import { ProjectProjection, ProjectProjectionLayer } from "@yodea/application/projections"
import { UseCases, UseCasesLayer } from "@yodea/application/use-cases"

const Sql = SqliteClient.layer({ filename: ":memory:", disableWAL: true })
// ONE shared EventStore (same constant referenced everywhere -> memoized to one instance).
const Store = EventStoreLayer.pipe(Layer.provide(Sql))
const Projection = ProjectProjectionLayer.pipe(Layer.provide(Store))
// Output UseCases + EventStore + EventBus so the test can inspect all three.
const TestLayer = UseCasesLayer.pipe(
  Layer.provide(Projection),
  Layer.provideMerge(Store),
  Layer.provideMerge(EventBusLayer)
)
// The change-directory use-case yields FileSystem+Path; supply them via the Bun
// platform layers (real FS, exercised against real temp dirs).
const TestLayerFs = TestLayer.pipe(Layer.provide(BunFileSystem.layer), Layer.provide(BunServices.layer))

describe("UseCases.createProject", () => {
  it("appends a durable event, broadcasts it live, and reflects it in the projection", async () => {
    const program = Effect.gen(function* () {
      const useCases = yield* UseCases
      const bus = yield* EventBus
      const store = yield* EventStore

      const sub = yield* bus.subscribe // subscribe before the command (deterministic)
      const { project } = yield* useCases.createProject("Hello", false)

      const broadcast = yield* PubSub.take(sub)
      const persisted = yield* store.readAll
      const listed = yield* useCases.listProjects()

      return { project, broadcast, persisted, listed }
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))

    const r = await Effect.runPromise(program)
    expect(r.project.name).toBe("Hello")
    expect(r.broadcast._tag).toBe("ProjectCreated")
    expect(r.broadcast.projectId).toBe(r.project.id) // same event broadcast as committed
    expect(r.persisted).toHaveLength(1)
    expect(r.listed).toEqual([r.project]) // read-your-writes
  })

  it("health returns ok", async () => {
    const ok = await Effect.runPromise(
      Effect.provide(Effect.flatMap(UseCases, (u) => u.health), TestLayerFs)
    )
    expect(ok).toBe("ok")
  })

  it("listProjects(includeArchived) accepts the flag and returns non-deleted projects", async () => {
    const r = await Effect.runPromise(Effect.gen(function* () {
      const u = yield* UseCases
      yield* u.createProject("alpha", false)
      return { def: yield* u.listProjects(false), all: yield* u.listProjects(true) }
    }).pipe(Effect.provide(TestLayerFs)))
    expect(r.def.map((p) => p.name)).toEqual(["alpha"])
    expect(r.all.map((p) => p.name)).toEqual(["alpha"])
  })

  // Locks the layer-composition shape the change-directory slice reuses:
  // BunFileSystem supplies FileSystem, BunServices supplies Path. UseCases
  // still resolves (it does not yield FS yet) — proving the wiring is additive.
  it("UseCases resolves with FileSystem+Path provided", async () => {
    const FsTestLayer = TestLayer.pipe(Layer.provide(BunFileSystem.layer), Layer.provide(BunServices.layer))
    const ok = await Effect.runPromise(Effect.provide(Effect.flatMap(UseCases, (u) => u.health), FsTestLayer))
    expect(ok).toBe("ok")
  })
})

describe("UseCases.changeDirectory", () => {
  it("sets a valid absolute existing directory and reflects it in the projection", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "yodea-cd-"))
    const program = Effect.gen(function* () {
      const u = yield* UseCases
      const { project } = yield* u.createProject("cdok", false)
      const updated = yield* u.changeDirectory(project.id, tmp)
      const listed = yield* u.listProjects()
      return { updated, listed }
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))
    const r = await Effect.runPromise(program)
    rmSync(tmp, { recursive: true, force: true })
    expect(r.updated.directory).toBe(tmp)
    expect(r.listed[0]?.directory).toBe(tmp)
  })
  it("fails ProjectNotFound for an unknown id", async () => {
    const program = Effect.gen(function* () {
      const u = yield* UseCases
      return yield* u.changeDirectory("nope", "/").pipe(Effect.result)
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))
    const exit = await Effect.runPromise(program)
    expect((exit as { failure: { _tag: string } }).failure._tag).toBe("ProjectNotFound")
  })
  it("fails ProjectDirectoryInvalid(not-absolute) for a relative path", async () => {
    const program = Effect.gen(function* () {
      const u = yield* UseCases
      const { project } = yield* u.createProject("cdrel", false)
      return yield* u.changeDirectory(project.id, "relative/dir").pipe(Effect.result)
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))
    const exit = await Effect.runPromise(program)
    const f = (exit as { failure: { _tag: string; reason: string } }).failure
    expect(f._tag).toBe("ProjectDirectoryInvalid")
    expect(f.reason).toBe("not-absolute")
  })
  it("fails ProjectDirectoryInvalid(not-found) for an absolute path that does not exist", async () => {
    const program = Effect.gen(function* () {
      const u = yield* UseCases
      const { project } = yield* u.createProject("cdmiss", false)
      return yield* u.changeDirectory(project.id, "/this/does/not/exist/yodea").pipe(Effect.result)
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))
    const exit = await Effect.runPromise(program)
    const f = (exit as { failure: { _tag: string; reason: string } }).failure
    expect(f._tag).toBe("ProjectDirectoryInvalid")
    expect(f.reason).toBe("not-found")
  })
  it("fails ProjectDirectoryConflict when another live project already uses the directory", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "yodea-cd-"))
    const program = Effect.gen(function* () {
      const u = yield* UseCases
      const a = (yield* u.createProject("cda", false)).project
      const b = (yield* u.createProject("cdb", false)).project
      yield* u.changeDirectory(a.id, tmp)
      return yield* u.changeDirectory(b.id, tmp).pipe(Effect.result)
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))
    const exit = await Effect.runPromise(program)
    rmSync(tmp, { recursive: true, force: true })
    expect((exit as { failure: { _tag: string } }).failure._tag).toBe("ProjectDirectoryConflict")
  })
})

describe("UseCases.archiveProject / restoreProject", () => {
  it("archives then restores a project, toggling archived + bumping updatedAt", async () => {
    const program = Effect.gen(function* () {
      const u = yield* UseCases
      const { project } = yield* u.createProject("toarch", false)
      const archived = yield* u.archiveProject(project.id)
      const restored = yield* u.restoreProject(project.id)
      return { project, archived, restored }
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))
    const r = await Effect.runPromise(program)
    expect(r.archived.archived).toBe(true)
    expect(r.archived.id).toBe(r.project.id)
    expect(r.restored.archived).toBe(false)
  })
  it("fails ProjectNotFound when the id is absent", async () => {
    const program = Effect.gen(function* () {
      const u = yield* UseCases
      return yield* u.archiveProject("00000000-0000-4000-8000-000000000000").pipe(Effect.result)
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))
    const exit = await Effect.runPromise(program)
    expect((exit as { failure: { _tag: string } }).failure._tag).toBe("ProjectNotFound")
  })
})

describe("UseCases.setMetadata", () => {
  it("replaces only provided fields, stamps updatedAt, and persists/broadcasts", async () => {
    const program = Effect.gen(function* () {
      const useCases = yield* UseCases
      const bus = yield* EventBus
      const store = yield* EventStore
      const { project } = yield* useCases.createProject("meta", false)
      const sub = yield* bus.subscribe
      const updated = yield* useCases.setMetadata(project.id, { description: "hi", tags: ["a", "a", "b"] })
      const broadcast = yield* PubSub.take(sub)
      const persisted = yield* store.readAll
      return { project, updated, broadcast, persisted }
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))

    const r = await Effect.runPromise(program)
    expect(r.updated.description).toBe("hi")
    expect(r.updated.tags).toEqual(["a", "b"]) // deduped via the fold
    expect(r.updated.id).toBe(r.project.id)
    expect(r.broadcast._tag).toBe("ProjectMetadataChanged")
    expect(r.persisted).toHaveLength(2) // ProjectCreated + ProjectMetadataChanged
  })

  it("fails with ProjectNotFound for an unknown id", async () => {
    const program = Effect.gen(function* () {
      const useCases = yield* UseCases
      return yield* useCases.setMetadata("nope", { description: "x" }).pipe(Effect.result)
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))
    const exit = await Effect.runPromise(program)
    expect((exit as { _tag: string; failure: { _tag: string } })._tag).toBe("Failure")
    expect((exit as { failure: { _tag: string } }).failure._tag).toBe("ProjectNotFound")
  })
})
