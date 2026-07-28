import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Path, Fiber, Option, Schedule, Layer } from "effect"
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

describe.sequential("project operations under concurrency", () => {
  it.live("name-uniqueness guard rejects a SEQUENTIAL re-use with ProjectNameConflict",  () => Effect.gen(function*() {
    const path = yield* Path.Path.pipe(Effect.provide(NodeServices.layer))
    const dir = yield* makeTestDirectory('expand-concurrency-')
    const program = Effect.gen(function* () {
      const dbPath = path.join(dir, "events.db")
      const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
      yield* awaitEndpointUp
      const out = yield* withClient(nodeAdapter, (client) =>
        Effect.gen(function* () {
          const a = (yield* client.ProjectCreate({ name: "alpha", ensure: false })).project
          const b = (yield* client.ProjectCreate({ name: "beta", ensure: false })).project
          const first = yield* client.ProjectRename({ id: a.id, name: "merged" }).pipe(Effect.result)
          const second = yield* client.ProjectRename({ id: b.id, name: "merged" }).pipe(Effect.result)
          const listed = yield* client.ProjectList({ includeArchived: true })
          return { first, second, listed, aId: a.id }
        })
      )
      yield* Fiber.interrupt(serverFiber)
      return out
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(ProcessServices.layer, Layer.succeed(AppContext, makeTestAppContext(path, dir)))))
    const r = (yield* (program)) as {
      first: { _tag: string }
      second: { _tag: string; failure?: { _tag: string } }
      listed: { projects: ReadonlyArray<{ id: string; name: string }> }
      aId: string
    }
    expect(r.first._tag).toBe("Success")
    expect(r.second._tag).toBe("Failure")
    expect(r.second.failure?._tag).toBe("ProjectNameConflict")
    const holders = r.listed.projects.filter((p) => p.name === "merged")
    expect(holders).toHaveLength(1)
    expect(holders[0]!.id).toBe(r.aId)
  }))

  it.live("concurrent rename to the same name has exactly one winner",  () => Effect.gen(function*() {
    const path = yield* Path.Path.pipe(Effect.provide(NodeServices.layer))
    const dir = yield* makeTestDirectory('expand-concurrency-')
    const program = Effect.gen(function* () {
      const dbPath = path.join(dir, "events.db")
      const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
      yield* awaitEndpointUp
      const out = yield* withClient(nodeAdapter, (client) =>
        Effect.gen(function* () {
          const a = (yield* client.ProjectCreate({ name: "alpha", ensure: false })).project
          const b = (yield* client.ProjectCreate({ name: "beta", ensure: false })).project
          const results = yield* Effect.all(
            [client.ProjectRename({ id: a.id, name: "merged" }).pipe(Effect.result),
             client.ProjectRename({ id: b.id, name: "merged" }).pipe(Effect.result)],
            { concurrency: "unbounded" }
          )
          const listed = yield* client.ProjectList({ includeArchived: true })
          return { results, listed, aId: a.id, bId: b.id }
        })
      )
      yield* Fiber.interrupt(serverFiber)
      return out
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(ProcessServices.layer, Layer.succeed(AppContext, makeTestAppContext(path, dir)))))
    const r = (yield* (program)) as {
      results: ReadonlyArray<{ _tag: string; failure?: { _tag: string } }>
      listed: { projects: ReadonlyArray<{ id: string; name: string }> }
      aId: string
      bId: string
    }
    expect(r.results).toHaveLength(2)
    expect(r.results.filter((x) => x._tag === "Success")).toHaveLength(1)
    expect(r.listed.projects).toHaveLength(2)
    const ids = r.listed.projects.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(ids)).toEqual(new Set([r.aId, r.bId]))
    const holders = r.listed.projects.filter((p) => p.name === "merged")
    expect(holders).toHaveLength(1)
    const loser = r.results.find((x) => x._tag === "Failure")
    expect(loser?.failure?._tag).toBe("ProjectNameConflict")
  }))

  it.live("a deleted (tombstoned) project never resurrects: restore fails ProjectNotFound",  () => Effect.gen(function*() {
    const path = yield* Path.Path.pipe(Effect.provide(NodeServices.layer))
    const dir = yield* makeTestDirectory('expand-concurrency-')
    const program = Effect.gen(function* () {
      const dbPath = path.join(dir, "events.db")
      const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
      yield* awaitEndpointUp
      const out = yield* withClient(nodeAdapter, (client) =>
        Effect.gen(function* () {
          const { project } = yield* client.ProjectCreate({ name: "doomed", ensure: false })
          yield* client.ProjectArchive({ id: project.id })
          yield* client.ProjectDelete({ id: project.id })
          const restore = yield* client.ProjectRestore({ id: project.id }).pipe(Effect.result)
          const listed = yield* client.ProjectList({ includeArchived: true })
          return { restore, listed }
        })
      )
      yield* Fiber.interrupt(serverFiber)
      return out
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(ProcessServices.layer, Layer.succeed(AppContext, makeTestAppContext(path, dir)))))
    const r = (yield* (program)) as {
      restore: { _tag: string; failure?: { _tag: string } }
      listed: { projects: ReadonlyArray<unknown> }
    }
    expect(r.restore._tag).toBe("Failure")
    expect(r.restore.failure?._tag).toBe("ProjectNotFound")
    expect(r.listed.projects).toEqual([])
  }))

  it.live("directory-uniqueness guard rejects a SEQUENTIAL re-use with ProjectDirectoryConflict",  () => Effect.gen(function*() {
    const path = yield* Path.Path.pipe(Effect.provide(NodeServices.layer))
    const dir = yield* makeTestDirectory('expand-concurrency-')
    const shared = yield* makeTestDirectory("expand-shared-seq-")
    const program = Effect.gen(function* () {
      const dbPath = path.join(dir, "events.db")
      const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
      yield* awaitEndpointUp
      const out = yield* withClient(nodeAdapter, (client) =>
        Effect.gen(function* () {
          const a = (yield* client.ProjectCreate({ name: "a", ensure: false })).project
          const b = (yield* client.ProjectCreate({ name: "b", ensure: false })).project
          const first = yield* client.ProjectChangeDirectory({ id: a.id, directory: shared }).pipe(Effect.result)
          const second = yield* client.ProjectChangeDirectory({ id: b.id, directory: shared }).pipe(Effect.result)
          const listed = yield* client.ProjectList({ includeArchived: true })
          return { first, second, listed, aId: a.id }
        })
      )
      yield* Fiber.interrupt(serverFiber)
      return out
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(ProcessServices.layer, Layer.succeed(AppContext, makeTestAppContext(path, dir)))))
    const r = (yield* (program)) as {
      first: { _tag: string }
      second: { _tag: string; failure?: { _tag: string } }
      listed: { projects: ReadonlyArray<{ id: string; directory: string | null }> }
      aId: string
    }
    expect(r.first._tag).toBe("Success")
    expect(r.second._tag).toBe("Failure")
    expect(r.second.failure?._tag).toBe("ProjectDirectoryConflict")
    const holders = r.listed.projects.filter((p) => p.directory === shared)
    expect(holders).toHaveLength(1)
    expect(holders[0]!.id).toBe(r.aId)
  }))

  it.live("concurrent ChangeDirectory on the same dir has exactly one winner",  () => Effect.gen(function*() {
    const path = yield* Path.Path.pipe(Effect.provide(NodeServices.layer))
    const dir = yield* makeTestDirectory('expand-concurrency-')
    const shared = yield* makeTestDirectory("expand-shared-")
    const program = Effect.gen(function* () {
      const dbPath = path.join(dir, "events.db")
      const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
      yield* awaitEndpointUp
      const out = yield* withClient(nodeAdapter, (client) =>
        Effect.gen(function* () {
          const a = (yield* client.ProjectCreate({ name: "a", ensure: false })).project
          const b = (yield* client.ProjectCreate({ name: "b", ensure: false })).project
          const results = yield* Effect.all(
            [client.ProjectChangeDirectory({ id: a.id, directory: shared }).pipe(Effect.result),
             client.ProjectChangeDirectory({ id: b.id, directory: shared }).pipe(Effect.result)],
            { concurrency: "unbounded" }
          )
          const listed = yield* client.ProjectList({ includeArchived: true })
          return { results, listed, aId: a.id, bId: b.id }
        })
      )
      yield* Fiber.interrupt(serverFiber)
      return out
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(ProcessServices.layer, Layer.succeed(AppContext, makeTestAppContext(path, dir)))))
    const r = (yield* (program)) as {
      results: ReadonlyArray<{ _tag: string }>
      listed: { projects: ReadonlyArray<{ id: string; directory: string | null }> }
      aId: string
      bId: string
    }
    expect(r.results).toHaveLength(2)
    expect(r.listed.projects).toHaveLength(2)
    const committed = r.results.filter((x) => x._tag === "Success")
    expect(committed).toHaveLength(1)
    const holders = r.listed.projects.filter((p) => p.directory === shared)
    expect(holders).toHaveLength(1)
  }))
})

const makeTestDirectory = (prefix: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix })),
    Effect.provide(NodeServices.layer)
  )

const makeTestAppContext = (path: Path.Path, dataDir: string) =>
  makeAppContext(path, { homeDir: dataDir, cwd: dataDir, dataDir })
