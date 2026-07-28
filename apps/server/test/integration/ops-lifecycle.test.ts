import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Path, Fiber, Option, Schedule, Queue, Layer } from "effect"
import { ProcessServices } from "@expand/server/node-process-control"
import { runServer } from "@expand/server/composition/app"
import { withClient } from "@expand/client-ts"
import { makeNodeAdapter } from "@expand/client-ts/adapters/node"
import { readEndpoint } from "@expand/client-ts"
import { AppContext, makeAppContext } from "@expand/contracts/app-context"

const nodeAdapter = makeNodeAdapter({
  backendCommand: Effect.succeed(["node", "--import", "tsx", "apps/server/main.ts"])
})


const awaitEndpointUp = readEndpoint.pipe(
  Effect.flatMap((o) => (Option.isSome(o) ? Effect.void : Effect.fail("pending" as const))),
  Effect.retry(Schedule.spaced("25 millis")),
  Effect.timeoutOrElse({
    duration: "5 seconds",
    orElse: () => Effect.fail("server never advertised an endpoint (I-3)")
  })
)

describe.sequential("project operations over the wire", () => {
  it.live("drives every operation and observes each event live",  () => Effect.gen(function*() {
    const path = yield* Path.Path.pipe(Effect.provide(NodeServices.layer))
    const dir = yield* makeTestDirectory('expand-ops-lifecycle-')
    const workdir = yield* makeTestDirectory("expand-projdir-")
    const program = Effect.gen(function* () {
      const dbPath = path.join(dir, "events.db")
      const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
      yield* awaitEndpointUp

      const outcome = yield* withClient(nodeAdapter, (client) =>
        Effect.gen(function* () {
          const events = yield* client.Events({}, { asQueue: true })
          yield* Effect.sleep("500 millis")

          const { project } = yield* client.ProjectCreate({ name: "ops", ensure: false })
          const renamed = yield* client.ProjectRename({ id: project.id, name: "ops-renamed" })
          const dirSet = yield* client.ProjectChangeDirectory({ id: project.id, directory: workdir })
          const archived = yield* client.ProjectArchive({ id: project.id })
          const restored = yield* client.ProjectRestore({ id: project.id })
          const meta = yield* client.ProjectSetMetadata({ id: project.id, description: "desc", tags: ["a", "b"] })
          const deleted = yield* client.ProjectDelete({ id: project.id })

          const tags: string[] = []
          for (let i = 0; i < 7; i++) tags.push((yield* Queue.take(events)).event._tag)

          const listed = yield* client.ProjectList({})
          return { renamed, dirSet, archived, restored, meta, deleted, tags, listed }
        })
      )
      yield* Fiber.interrupt(serverFiber)
      return outcome
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(ProcessServices.layer, Layer.succeed(AppContext, makeTestAppContext(path, dir)))))

    const r = yield* (program)
    expect(r.renamed.name).toBe("ops-renamed")
    expect(r.dirSet.directory).toBe(workdir)
    expect(r.archived.archived).toBe(true)
    expect(r.restored.archived).toBe(false)
    expect(r.meta.description).toBe("desc")
    expect([...r.meta.tags]).toEqual(["a", "b"])
    expect(r.deleted).toEqual({ id: r.renamed.id, deleted: true })
    expect(r.tags).toEqual([
      "ProjectCreated", "ProjectRenamed", "ProjectDirectoryChanged",
      "ProjectArchived", "ProjectRestored", "ProjectMetadataChanged", "ProjectDeleted"
    ])
    expect(r.listed.projects).toEqual([])
  }))

  it.live("rejects a non-absolute / non-existent directory with the typed error over the wire",  () => Effect.gen(function*() {
    const path = yield* Path.Path.pipe(Effect.provide(NodeServices.layer))
    const dir = yield* makeTestDirectory('expand-ops-lifecycle-')
    const program = Effect.gen(function* () {
      const dbPath = path.join(dir, "events.db")
      const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
      yield* awaitEndpointUp
      const result = yield* withClient(nodeAdapter, (client) =>
        Effect.gen(function* () {
          const { project } = yield* client.ProjectCreate({ name: "dirfail", ensure: false })
          return yield* client.ProjectChangeDirectory({ id: project.id, directory: "/definitely/not/here" }).pipe(Effect.result)
        })
      )
      yield* Fiber.interrupt(serverFiber)
      return result
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(ProcessServices.layer, Layer.succeed(AppContext, makeTestAppContext(path, dir)))))
    const r = yield* (program)
    expect(r._tag).toBe("Failure")
    if (r._tag === "Failure") expect((r.failure as { _tag: string })._tag).toBe("ProjectDirectoryInvalid")
  }))
})

const makeTestDirectory = (prefix: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix })),
    Effect.provide(NodeServices.layer)
  )

const makeTestAppContext = (path: Path.Path, dataDir: string) =>
  makeAppContext(path, { homeDir: dataDir, cwd: dataDir, dataDir })
