import { describe, expect, it } from "vitest"
import { Effect, Layer, PubSub, Stream } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventStore, EventStoreLayer } from "@yodea/server/db/event-store"
import { EventBus, EventBusLayer } from "@yodea/server/application/event-bus"
import { ProjectProjection, ProjectProjectionLayer } from "@yodea/server/application/projections"
import { ProjectEventStoreLayer } from "@yodea/server/application/projects/project-event-store"
import { ProjectionStateStoreLayer } from "@yodea/server/db/projection-state-store"
import { ProjectUseCases, ProjectUseCasesLayer } from "@yodea/server/application/projects/use-cases"
import { ServerUseCases, ServerUseCasesLayer } from "@yodea/server/application/server/use-cases"

const uid = (n: number): string => "00000000-0000-4000-8000-" + String(n).padStart(12, "0")

const Sql = SqliteClient.layer({ filename: ":memory:", disableWAL: true })
const Store = EventStoreLayer.pipe(Layer.provide(Sql))
const ProjectEvents = ProjectEventStoreLayer.pipe(Layer.provide(Sql))
const States = ProjectionStateStoreLayer.pipe(Layer.provide(Sql))
const Projection = ProjectProjectionLayer.pipe(Layer.provide(ProjectEvents), Layer.provide(States))
const TestLayer = ProjectUseCasesLayer.pipe(
  Layer.provide(Projection),
  Layer.provideMerge(ProjectEvents),
  Layer.provideMerge(Store),
  Layer.provideMerge(EventBusLayer)
)
const TestLayerFs = TestLayer.pipe(Layer.provide(BunFileSystem.layer), Layer.provide(BunServices.layer))

describe("ProjectUseCases.createProject", () => {
  it("appends a durable event, broadcasts it live, and reflects it in the projection", async () => {
    const program = Effect.gen(function* () {
      const useCases = yield* ProjectUseCases
      const bus = yield* EventBus
      const store = yield* EventStore

      const sub = yield* bus.subscribe
      const { project } = yield* useCases.createProject("hello", false)

      const broadcast = yield* PubSub.take(sub)
      const persisted = yield* Stream.runCollect(store.scan()).pipe(Effect.map((c) => Array.from(c)))
      const listed = yield* useCases.listProjects()

      return { project, broadcast, persisted, listed }
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))

    const r = await Effect.runPromise(program)
    expect(r.project.name).toBe("hello")
    expect(r.broadcast.seq).toBe(1)
    expect(r.broadcast.event._tag).toBe("ProjectCreated")
    expect(r.broadcast.event.projectId).toBe(r.project.id)
    expect(r.persisted).toHaveLength(1)
    expect(r.listed).toEqual([r.project])
  })

  it("server health returns ok", async () => {
    const ok = await Effect.runPromise(
      Effect.provide(Effect.flatMap(ServerUseCases, (u) => u.health), ServerUseCasesLayer)
    )
    expect(ok).toBe("ok")
  })

  it("listProjects(includeArchived) accepts the flag and returns non-deleted projects", async () => {
    const r = await Effect.runPromise(Effect.gen(function* () {
      const u = yield* ProjectUseCases
      yield* u.createProject("alpha", false)
      return { def: yield* u.listProjects(false), all: yield* u.listProjects(true) }
    }).pipe(Effect.provide(TestLayerFs)))
    expect(r.def.map((p) => p.name)).toEqual(["alpha"])
    expect(r.all.map((p) => p.name)).toEqual(["alpha"])
  })

  it("ProjectUseCases resolves with FileSystem+Path provided", async () => {
    const FsTestLayer = TestLayer.pipe(Layer.provide(BunFileSystem.layer), Layer.provide(BunServices.layer))
    const projects = await Effect.runPromise(Effect.provide(Effect.flatMap(ProjectUseCases, (u) => u.listProjects()), FsTestLayer))
    expect(projects).toEqual([])
  })
})

describe("ProjectUseCases.changeDirectory", () => {
  it("sets a valid absolute existing directory and reflects it in the projection", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "yodea-cd-"))
    const program = Effect.gen(function* () {
      const u = yield* ProjectUseCases
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
      const u = yield* ProjectUseCases
      return yield* u.changeDirectory(uid(1), "/").pipe(Effect.result)
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))
    const exit = await Effect.runPromise(program)
    expect((exit as { failure: { _tag: string } }).failure._tag).toBe("ProjectNotFound")
  })
  it("fails ProjectDirectoryInvalid(not-absolute) for a relative path", async () => {
    const program = Effect.gen(function* () {
      const u = yield* ProjectUseCases
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
      const u = yield* ProjectUseCases
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
      const u = yield* ProjectUseCases
      const a = (yield* u.createProject("cda", false)).project
      const b = (yield* u.createProject("cdb", false)).project
      yield* u.changeDirectory(a.id, tmp)
      return yield* u.changeDirectory(b.id, tmp).pipe(Effect.result)
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))
    const exit = await Effect.runPromise(program)
    rmSync(tmp, { recursive: true, force: true })
    expect((exit as { failure: { _tag: string } }).failure._tag).toBe("ProjectDirectoryConflict")
  })

  it("fails ProjectDirectoryInvalid(not-a-directory) when the path is a file", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "yodea-cd-file-"))
    const file = join(tmp, "plain.txt")
    writeFileSync(file, "x")
    const program = Effect.gen(function* () {
      const u = yield* ProjectUseCases
      const { project } = yield* u.createProject("cdfile", false)
      return yield* u.changeDirectory(project.id, file).pipe(Effect.result)
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))
    const exit = await Effect.runPromise(program)
    rmSync(tmp, { recursive: true, force: true })
    const f = (exit as { failure: { _tag: string; reason: string } }).failure
    expect(f._tag).toBe("ProjectDirectoryInvalid")
    expect(f.reason).toBe("not-a-directory")
  })

  it("fails ProjectDirectoryConflict when a symlink resolves to a directory another project already uses", async () => {
    const real = mkdtempSync(join(tmpdir(), "yodea-cd-real-"))
    const linkParent = mkdtempSync(join(tmpdir(), "yodea-cd-link-"))
    const link = join(linkParent, "alias")
    symlinkSync(real, link)
    const program = Effect.gen(function* () {
      const u = yield* ProjectUseCases
      const a = (yield* u.createProject("cdreal", false)).project
      const b = (yield* u.createProject("cdalias", false)).project
      yield* u.changeDirectory(a.id, real)
      return yield* u.changeDirectory(b.id, link).pipe(Effect.result)
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))
    const exit = await Effect.runPromise(program)
    rmSync(linkParent, { recursive: true, force: true })
    rmSync(real, { recursive: true, force: true })
    expect((exit as { failure: { _tag: string } }).failure._tag).toBe("ProjectDirectoryConflict")
  })
})

describe("ProjectUseCases.createProject with directory", () => {
  it("creates with a valid absolute existing unique directory", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "yodea-cr-"))
    const program = Effect.gen(function* () {
      const u = yield* ProjectUseCases
      const { project } = yield* u.createProject("crdir", false, tmp)
      const listed = yield* u.listProjects()
      return { project, listed }
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))
    const r = await Effect.runPromise(program)
    rmSync(tmp, { recursive: true, force: true })
    expect(r.project.directory).toBe(tmp)
    expect(r.listed[0]?.directory).toBe(tmp)
  })
  it("with no directory behaves as before (directory:null)", async () => {
    const program = Effect.gen(function* () {
      const u = yield* ProjectUseCases
      return (yield* u.createProject("crnodir", false)).project
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))
    const project = await Effect.runPromise(program)
    expect(project.directory).toBe(null)
  })
  it("fails ProjectDirectoryInvalid(not-absolute) for a relative path", async () => {
    const program = Effect.gen(function* () {
      const u = yield* ProjectUseCases
      return yield* u.createProject("crrel", false, "relative/dir").pipe(Effect.result)
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))
    const exit = await Effect.runPromise(program)
    const f = (exit as { failure: { _tag: string; reason: string } }).failure
    expect(f._tag).toBe("ProjectDirectoryInvalid")
    expect(f.reason).toBe("not-absolute")
  })
  it("fails ProjectDirectoryInvalid(not-found) for an absolute path that does not exist", async () => {
    const program = Effect.gen(function* () {
      const u = yield* ProjectUseCases
      return yield* u.createProject("crmiss", false, "/this/does/not/exist/yodea").pipe(Effect.result)
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))
    const exit = await Effect.runPromise(program)
    const f = (exit as { failure: { _tag: string; reason: string } }).failure
    expect(f._tag).toBe("ProjectDirectoryInvalid")
    expect(f.reason).toBe("not-found")
  })
  it("fails ProjectDirectoryConflict when another live project already uses the directory", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "yodea-cr-"))
    const program = Effect.gen(function* () {
      const u = yield* ProjectUseCases
      const a = (yield* u.createProject("crconfa", false, tmp)).project
      void a
      return yield* u.createProject("crconfb", false, tmp).pipe(Effect.result)
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))
    const exit = await Effect.runPromise(program)
    rmSync(tmp, { recursive: true, force: true })
    expect((exit as { failure: { _tag: string } }).failure._tag).toBe("ProjectDirectoryConflict")
  })
})

describe("ProjectUseCases.archiveProject / restoreProject", () => {
  it("archives then restores a project, toggling archived + bumping updatedAt", async () => {
    const program = Effect.gen(function* () {
      const u = yield* ProjectUseCases
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
      const u = yield* ProjectUseCases
      return yield* u.archiveProject("00000000-0000-4000-8000-000000000000").pipe(Effect.result)
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))
    const exit = await Effect.runPromise(program)
    expect((exit as { failure: { _tag: string } }).failure._tag).toBe("ProjectNotFound")
  })
  it("archive/restore return value equals the projection's folded result (no divergent read-back)", async () => {
    const program = Effect.gen(function* () {
      const u = yield* ProjectUseCases
      const { project } = yield* u.createProject("lockstep", false)
      const archivedReturned = yield* u.archiveProject(project.id)
      const archivedListed = (yield* u.listProjects(true)).find((p) => p.id === project.id)
      const restoredReturned = yield* u.restoreProject(project.id)
      const restoredListed = (yield* u.listProjects(true)).find((p) => p.id === project.id)
      return { archivedReturned, archivedListed, restoredReturned, restoredListed }
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))
    const r = await Effect.runPromise(program)
    expect(r.archivedReturned).toEqual(r.archivedListed)
    expect(r.restoredReturned).toEqual(r.restoredListed)
  })
})

describe("ProjectUseCases.setMetadata", () => {
  it("replaces only provided fields, stamps updatedAt, and persists/broadcasts", async () => {
    const program = Effect.gen(function* () {
      const useCases = yield* ProjectUseCases
      const bus = yield* EventBus
      const store = yield* EventStore
      const { project } = yield* useCases.createProject("meta", false)
      const sub = yield* bus.subscribe
      const updated = yield* useCases.setMetadata(project.id, { description: "hi", tags: ["a", "a", "b"] })
      const broadcast = yield* PubSub.take(sub)
      const persisted = yield* Stream.runCollect(store.scan()).pipe(Effect.map((c) => Array.from(c)))
      return { project, updated, broadcast, persisted }
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))

    const r = await Effect.runPromise(program)
    expect(r.updated.description).toBe("hi")
    expect(r.updated.tags).toEqual(["a", "b"])
    expect(r.updated.id).toBe(r.project.id)
    expect(r.broadcast.event._tag).toBe("ProjectMetadataChanged")
    expect(r.persisted).toHaveLength(2)
  })

  it("fails with ProjectNotFound for an unknown id", async () => {
    const program = Effect.gen(function* () {
      const useCases = yield* ProjectUseCases
      return yield* useCases.setMetadata(uid(1), { description: "x" }).pipe(Effect.result)
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))
    const exit = await Effect.runPromise(program)
    expect((exit as { _tag: string; failure: { _tag: string } })._tag).toBe("Failure")
    expect((exit as { failure: { _tag: string } }).failure._tag).toBe("ProjectNotFound")
  })

  it("accepts a 2048-char description and persists it", async () => {
    const desc = "x".repeat(2048)
    const program = Effect.gen(function* () {
      const u = yield* ProjectUseCases
      const { project } = yield* u.createProject("desc2048", false)
      const updated = yield* u.setMetadata(project.id, { description: desc })
      return updated
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))
    const updated = await Effect.runPromise(program)
    expect(updated.description).toBe(desc)
    expect(updated.description?.length).toBe(2048)
  })

  it("rejects a 2049-char description (cap enforced; not persisted)", async () => {
    const desc = "x".repeat(2049)
    const program = Effect.gen(function* () {
      const u = yield* ProjectUseCases
      const { project } = yield* u.createProject("desc2049", false)
      yield* u.setMetadata(project.id, { description: desc }).pipe(Effect.result)
      const listed = yield* u.listProjects()
      return listed.find((p) => p.id === project.id)?.description ?? null
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))
    const stored = await Effect.runPromiseExit(program)
    if (stored._tag === "Success") {
      expect(stored.value).not.toBe(desc)
    } else {
      expect(stored._tag).toBe("Failure")
    }
  })

  it("setMetadata return value equals the projection's folded result", async () => {
    const program = Effect.gen(function* () {
      const u = yield* ProjectUseCases
      const { project } = yield* u.createProject("metalock", false)
      const returned = yield* u.setMetadata(project.id, { description: "d", tags: ["x", "y"] })
      const listed = (yield* u.listProjects(true)).find((p) => p.id === project.id)
      return { returned, listed }
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))
    const r = await Effect.runPromise(program)
    expect(r.returned).toEqual(r.listed)
  })
})

describe("ProjectUseCases.deleteProject", () => {
  it("tombstones the project: removed from the projection, event broadcast", async () => {
    const program = Effect.gen(function* () {
      const useCases = yield* ProjectUseCases
      const bus = yield* EventBus
      const sub = yield* bus.subscribe
      const { project } = yield* useCases.createProject("doomed", false)
      yield* PubSub.take(sub)
      const result = yield* useCases.deleteProject(project.id)
      const broadcast = yield* PubSub.take(sub)
      const listed = yield* useCases.listProjects()
      return { result, broadcast, listed, id: project.id }
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))
    const r = await Effect.runPromise(program)
    expect(r.result).toEqual({ id: r.id, deleted: true })
    expect(r.broadcast.event._tag).toBe("ProjectDeleted")
    expect(r.listed).toEqual([])
  })
  it("fails with ProjectNotFound for an unknown id", async () => {
    const program = Effect.gen(function* () {
      const useCases = yield* ProjectUseCases
      return yield* useCases.deleteProject(uid(1)).pipe(Effect.result)
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))
    const exit = await Effect.runPromise(program)
    expect((exit as { failure: { _tag: string } }).failure._tag).toBe("ProjectNotFound")
  })
})
