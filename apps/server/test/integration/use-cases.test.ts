import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect, FileSystem, Layer, PubSub, Stream } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { NodeFileSystem, NodeServices } from "@effect/platform-node"
import { ReplayFeed, ReplayFeedLayer } from "@expand/server/db/replay-feed"
import { EventBus, EventBusLayer } from "@expand/server/application/event-bus"
import { ProjectProjection, ProjectProjectionLayer } from "@expand/server/application/projections"
import { ProjectEventStoreLayer } from "@expand/server/application/projects/project-event-store"
import { ProjectionStateStoreLayer } from "@expand/server/db/projection-state-store"
import { ProjectUseCases, ProjectUseCasesLayer } from "@expand/server/application/projects/use-cases"
import { ServerUseCases, ServerUseCasesLayer } from "@expand/server/application/server/use-cases"

const uid = (n: number): string => "00000000-0000-4000-8000-" + String(n).padStart(12, "0")

const Sql = SqliteClient.layer({ filename: ":memory:", disableWAL: true })
const Replay = ReplayFeedLayer.pipe(Layer.provide(Sql))
const ProjectEvents = ProjectEventStoreLayer.pipe(Layer.provide(Sql))
const States = ProjectionStateStoreLayer.pipe(Layer.provide(Sql))
const Projection = ProjectProjectionLayer.pipe(Layer.provide(ProjectEvents), Layer.provide(States))
const TestLayer = ProjectUseCasesLayer.pipe(
  Layer.provide(Projection),
  Layer.provideMerge(ProjectEvents),
  Layer.provideMerge(Replay),
  Layer.provideMerge(EventBusLayer)
)
const TestLayerFs = TestLayer.pipe(Layer.provide(NodeFileSystem.layer), Layer.provideMerge(NodeServices.layer))

describe("ProjectUseCases.createProject", () => {
  it.live("appends a durable event, broadcasts it live, and reflects it in the projection",  () => Effect.gen(function*() {
    const program = Effect.gen(function* () {
      const useCases = yield* ProjectUseCases
      const bus = yield* EventBus
      const feed = yield* ReplayFeed

      const sub = yield* bus.subscribe
      const { project } = yield* useCases.createProject("hello", false)

      const broadcast = yield* PubSub.take(sub)
      const persisted = yield* Stream.runCollect(feed.read(0)).pipe(Effect.map((c) => Array.from(c)))
      const listed = yield* useCases.listProjects()

      return { project, broadcast, persisted, listed }
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))

    const r = yield* (program)
    expect(r.project.name).toBe("hello")
    expect(r.broadcast.seq).toBe(1)
    expect(r.broadcast.event._tag).toBe("ProjectCreated")
    expect(r.broadcast.event.projectId).toBe(r.project.id)
    expect(r.persisted).toHaveLength(1)
    expect(r.listed).toEqual([r.project])
  }))

  it.live("server health returns ok",  () => Effect.gen(function*() {
    const ok = yield* (Effect.provide(Effect.flatMap(ServerUseCases, (u) => u.health), ServerUseCasesLayer))
    expect(ok).toBe("ok")
  }))

  it.live("listProjects(includeArchived) accepts the flag and returns non-deleted projects",  () => Effect.gen(function*() {
    const r = yield* (Effect.gen(function* () {
      const u = yield* ProjectUseCases
      yield* u.createProject("alpha", false)
      return { def: yield* u.listProjects(false), all: yield* u.listProjects(true) }
    }).pipe(Effect.provide(TestLayerFs)))
    expect(r.def.map((p) => p.name)).toEqual(["alpha"])
    expect(r.all.map((p) => p.name)).toEqual(["alpha"])
  }))

  it.live("ProjectUseCases resolves with FileSystem+Path provided",  () => Effect.gen(function*() {
    const FsTestLayer = TestLayer.pipe(Layer.provide(NodeFileSystem.layer), Layer.provide(NodeServices.layer))
    const projects = yield* (Effect.provide(Effect.flatMap(ProjectUseCases, (u) => u.listProjects()), FsTestLayer))
    expect(projects).toEqual([])
  }))
})

describe("ProjectUseCases.changeDirectory", () => {
  it.live("sets a valid absolute existing directory and reflects it in the projection",  () => Effect.gen(function*() {
    const tmp = yield* makeTestDirectory("expand-cd-")
    const program = Effect.gen(function* () {
      const u = yield* ProjectUseCases
      const { project } = yield* u.createProject("cdok", false)
      const updated = yield* u.changeDirectory(project.id, tmp)
      const listed = yield* u.listProjects()
      return { updated, listed }
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))
    const r = yield* (program)
    expect(r.updated.directory).toBe(tmp)
    expect(r.listed[0]?.directory).toBe(tmp)
  }))
  it.live("fails ProjectNotFound for an unknown id",  () => Effect.gen(function*() {
    const program = Effect.gen(function* () {
      const u = yield* ProjectUseCases
      return yield* u.changeDirectory(uid(1), "/").pipe(Effect.result)
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))
    const exit = yield* (program)
    expect((exit as { failure: { _tag: string } }).failure._tag).toBe("ProjectNotFound")
  }))
  it.live("fails ProjectDirectoryInvalid(not-absolute) for a relative path",  () => Effect.gen(function*() {
    const program = Effect.gen(function* () {
      const u = yield* ProjectUseCases
      const { project } = yield* u.createProject("cdrel", false)
      return yield* u.changeDirectory(project.id, "relative/dir").pipe(Effect.result)
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))
    const exit = yield* (program)
    const f = (exit as { failure: { _tag: string; reason: string } }).failure
    expect(f._tag).toBe("ProjectDirectoryInvalid")
    expect(f.reason).toBe("not-absolute")
  }))
  it.live("fails ProjectDirectoryInvalid(not-found) for an absolute path that does not exist",  () => Effect.gen(function*() {
    const program = Effect.gen(function* () {
      const u = yield* ProjectUseCases
      const { project } = yield* u.createProject("cdmiss", false)
      return yield* u.changeDirectory(project.id, "/this/does/not/exist/expand").pipe(Effect.result)
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))
    const exit = yield* (program)
    const f = (exit as { failure: { _tag: string; reason: string } }).failure
    expect(f._tag).toBe("ProjectDirectoryInvalid")
    expect(f.reason).toBe("not-found")
  }))
  it.live("fails ProjectDirectoryConflict when another live project already uses the directory",  () => Effect.gen(function*() {
    const tmp = yield* makeTestDirectory("expand-cd-")
    const program = Effect.gen(function* () {
      const u = yield* ProjectUseCases
      const a = (yield* u.createProject("cda", false)).project
      const b = (yield* u.createProject("cdb", false)).project
      yield* u.changeDirectory(a.id, tmp)
      return yield* u.changeDirectory(b.id, tmp).pipe(Effect.result)
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))
    const exit = yield* (program)
    expect((exit as { failure: { _tag: string } }).failure._tag).toBe("ProjectDirectoryConflict")
  }))

  it.live("fails ProjectDirectoryInvalid(not-a-directory) when the path is a file",  () => Effect.gen(function*() {
    const tmp = yield* makeTestDirectory("expand-cd-file-")
    const file = `${tmp}/plain.txt`
    yield* writeTestFile(file, "x")
    const program = Effect.gen(function* () {
      const u = yield* ProjectUseCases
      const { project } = yield* u.createProject("cdfile", false)
      return yield* u.changeDirectory(project.id, file).pipe(Effect.result)
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))
    const exit = yield* (program)
    const f = (exit as { failure: { _tag: string; reason: string } }).failure
    expect(f._tag).toBe("ProjectDirectoryInvalid")
    expect(f.reason).toBe("not-a-directory")
  }))

  it.live("fails ProjectDirectoryConflict when a symlink resolves to a directory another project already uses",  () => Effect.gen(function*() {
    const real = yield* makeTestDirectory("expand-cd-real-")
    const linkParent = yield* makeTestDirectory("expand-cd-link-")
    const link = `${linkParent}/alias`
    yield* makeTestSymlink(real, link)
    const program = Effect.gen(function* () {
      const u = yield* ProjectUseCases
      const a = (yield* u.createProject("cdreal", false)).project
      const b = (yield* u.createProject("cdalias", false)).project
      yield* u.changeDirectory(a.id, real)
      return yield* u.changeDirectory(b.id, link).pipe(Effect.result)
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))
    const exit = yield* (program)
    expect((exit as { failure: { _tag: string } }).failure._tag).toBe("ProjectDirectoryConflict")
  }))
})

describe("ProjectUseCases.createProject with directory", () => {
  it.live("creates with a valid absolute existing unique directory",  () => Effect.gen(function*() {
    const tmp = yield* makeTestDirectory("expand-cr-")
    const program = Effect.gen(function* () {
      const u = yield* ProjectUseCases
      const { project } = yield* u.createProject("crdir", false, tmp)
      const listed = yield* u.listProjects()
      return { project, listed }
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))
    const r = yield* (program)
    expect(r.project.directory).toBe(tmp)
    expect(r.listed[0]?.directory).toBe(tmp)
  }))
  it.live("with no directory behaves as before (directory:null)",  () => Effect.gen(function*() {
    const program = Effect.gen(function* () {
      const u = yield* ProjectUseCases
      return (yield* u.createProject("crnodir", false)).project
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))
    const project = yield* (program)
    expect(project.directory).toBe(null)
  }))
  it.live("fails ProjectDirectoryInvalid(not-absolute) for a relative path",  () => Effect.gen(function*() {
    const program = Effect.gen(function* () {
      const u = yield* ProjectUseCases
      return yield* u.createProject("crrel", false, "relative/dir").pipe(Effect.result)
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))
    const exit = yield* (program)
    const f = (exit as { failure: { _tag: string; reason: string } }).failure
    expect(f._tag).toBe("ProjectDirectoryInvalid")
    expect(f.reason).toBe("not-absolute")
  }))
  it.live("fails ProjectDirectoryInvalid(not-found) for an absolute path that does not exist",  () => Effect.gen(function*() {
    const program = Effect.gen(function* () {
      const u = yield* ProjectUseCases
      return yield* u.createProject("crmiss", false, "/this/does/not/exist/expand").pipe(Effect.result)
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))
    const exit = yield* (program)
    const f = (exit as { failure: { _tag: string; reason: string } }).failure
    expect(f._tag).toBe("ProjectDirectoryInvalid")
    expect(f.reason).toBe("not-found")
  }))
  it.live("fails ProjectDirectoryConflict when another live project already uses the directory",  () => Effect.gen(function*() {
    const tmp = yield* makeTestDirectory("expand-cr-")
    const program = Effect.gen(function* () {
      const u = yield* ProjectUseCases
      const a = (yield* u.createProject("crconfa", false, tmp)).project
      void a
      return yield* u.createProject("crconfb", false, tmp).pipe(Effect.result)
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))
    const exit = yield* (program)
    expect((exit as { failure: { _tag: string } }).failure._tag).toBe("ProjectDirectoryConflict")
  }))
})

describe("ProjectUseCases.archiveProject / restoreProject", () => {
  it.live("archives then restores a project, toggling archived + bumping updatedAt",  () => Effect.gen(function*() {
    const program = Effect.gen(function* () {
      const u = yield* ProjectUseCases
      const { project } = yield* u.createProject("toarch", false)
      const archived = yield* u.archiveProject(project.id)
      const restored = yield* u.restoreProject(project.id)
      return { project, archived, restored }
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))
    const r = yield* (program)
    expect(r.archived.archived).toBe(true)
    expect(r.archived.id).toBe(r.project.id)
    expect(r.restored.archived).toBe(false)
  }))
  it.live("fails ProjectNotFound when the id is absent",  () => Effect.gen(function*() {
    const program = Effect.gen(function* () {
      const u = yield* ProjectUseCases
      return yield* u.archiveProject("00000000-0000-4000-8000-000000000000").pipe(Effect.result)
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))
    const exit = yield* (program)
    expect((exit as { failure: { _tag: string } }).failure._tag).toBe("ProjectNotFound")
  }))
  it.live("archive/restore return value equals the projection's folded result (no divergent read-back)",  () => Effect.gen(function*() {
    const program = Effect.gen(function* () {
      const u = yield* ProjectUseCases
      const { project } = yield* u.createProject("lockstep", false)
      const archivedReturned = yield* u.archiveProject(project.id)
      const archivedListed = (yield* u.listProjects(true)).find((p) => p.id === project.id)
      const restoredReturned = yield* u.restoreProject(project.id)
      const restoredListed = (yield* u.listProjects(true)).find((p) => p.id === project.id)
      return { archivedReturned, archivedListed, restoredReturned, restoredListed }
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))
    const r = yield* (program)
    expect(r.archivedReturned).toEqual(r.archivedListed)
    expect(r.restoredReturned).toEqual(r.restoredListed)
  }))
})

describe("ProjectUseCases.setMetadata", () => {
  it.live("replaces only provided fields, stamps updatedAt, and persists/broadcasts",  () => Effect.gen(function*() {
    const program = Effect.gen(function* () {
      const useCases = yield* ProjectUseCases
      const bus = yield* EventBus
      const feed = yield* ReplayFeed
      const { project } = yield* useCases.createProject("meta", false)
      const sub = yield* bus.subscribe
      const updated = yield* useCases.setMetadata(project.id, { description: "hi", tags: ["a", "a", "b"] })
      const broadcast = yield* PubSub.take(sub)
      const persisted = yield* Stream.runCollect(feed.read(0)).pipe(Effect.map((c) => Array.from(c)))
      return { project, updated, broadcast, persisted }
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))

    const r = yield* (program)
    expect(r.updated.description).toBe("hi")
    expect(r.updated.tags).toEqual(["a", "b"])
    expect(r.updated.id).toBe(r.project.id)
    expect(r.broadcast.event._tag).toBe("ProjectMetadataChanged")
    expect(r.persisted).toHaveLength(2)
  }))

  it.live("fails with ProjectNotFound for an unknown id",  () => Effect.gen(function*() {
    const program = Effect.gen(function* () {
      const useCases = yield* ProjectUseCases
      return yield* useCases.setMetadata(uid(1), { description: "x" }).pipe(Effect.result)
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))
    const exit = yield* (program)
    expect((exit as { _tag: string; failure: { _tag: string } })._tag).toBe("Failure")
    expect((exit as { failure: { _tag: string } }).failure._tag).toBe("ProjectNotFound")
  }))

  it.live("accepts a 2048-char description and persists it",  () => Effect.gen(function*() {
    const desc = "x".repeat(2048)
    const program = Effect.gen(function* () {
      const u = yield* ProjectUseCases
      const { project } = yield* u.createProject("desc2048", false)
      const updated = yield* u.setMetadata(project.id, { description: desc })
      return updated
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))
    const updated = yield* (program)
    expect(updated.description).toBe(desc)
    expect(updated.description?.length).toBe(2048)
  }))

  it.live("rejects a 2049-char description (cap enforced; not persisted)",  () => Effect.gen(function*() {
    const desc = "x".repeat(2049)
    const program = Effect.gen(function* () {
      const u = yield* ProjectUseCases
      const { project } = yield* u.createProject("desc2049", false)
      yield* u.setMetadata(project.id, { description: desc }).pipe(Effect.result)
      const listed = yield* u.listProjects()
      return listed.find((p) => p.id === project.id)?.description ?? null
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))
    const stored = yield* Effect.exit(program)
    if (stored._tag === "Success") {
      expect(stored.value).not.toBe(desc)
    } else {
      expect(stored._tag).toBe("Failure")
    }
  }))

  it.live("setMetadata return value equals the projection's folded result",  () => Effect.gen(function*() {
    const program = Effect.gen(function* () {
      const u = yield* ProjectUseCases
      const { project } = yield* u.createProject("metalock", false)
      const returned = yield* u.setMetadata(project.id, { description: "d", tags: ["x", "y"] })
      const listed = (yield* u.listProjects(true)).find((p) => p.id === project.id)
      return { returned, listed }
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))
    const r = yield* (program)
    expect(r.returned).toEqual(r.listed)
  }))
})

describe("ProjectUseCases.deleteProject", () => {
  it.live("tombstones the project: removed from the projection, event broadcast",  () => Effect.gen(function*() {
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
    const r = yield* (program)
    expect(r.result).toEqual({ id: r.id, deleted: true })
    expect(r.broadcast.event._tag).toBe("ProjectDeleted")
    expect(r.listed).toEqual([])
  }))
  it.live("fails with ProjectNotFound for an unknown id",  () => Effect.gen(function*() {
    const program = Effect.gen(function* () {
      const useCases = yield* ProjectUseCases
      return yield* useCases.deleteProject(uid(1)).pipe(Effect.result)
    }).pipe(Effect.scoped, Effect.provide(TestLayerFs))
    const exit = yield* (program)
    expect((exit as { failure: { _tag: string } }).failure._tag).toBe("ProjectNotFound")
  }))
})

const makeTestDirectory = (prefix: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix })),
    Effect.provide(NodeServices.layer)
  )

const writeTestFile = (path: string, content: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.writeFileString(path, content)),
    Effect.provide(NodeServices.layer)
  )

const makeTestSymlink = (target: string, path: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.symlink(target, path)),
    Effect.provide(NodeServices.layer)
  )
