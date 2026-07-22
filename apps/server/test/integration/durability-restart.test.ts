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
    orElse: () => Effect.fail(new Error("server never advertised an endpoint (I-3)"))
  })
)

describe.sequential("durability across a backend restart", () => {
  it.live("re-folds all mutations after a full backend restart on the same db",  () => Effect.gen(function*() {
    const path = yield* Path.Path.pipe(Effect.provide(NodeServices.layer))
    const dir = yield* makeTestDirectory('expand-durability-restart-')
    const dbPath = path.join(dir, "events.db")
    const boot = (
      use: (
        c: import("@expand/client-ts").ExpandRpcClientApi
      ) => Effect.Effect<unknown, unknown, never>
    ) =>
      Effect.gen(function* () {
        const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
        yield* awaitEndpointUp
        const out = yield* withClient(nodeAdapter, use)
        yield* Fiber.join(serverFiber).pipe(
          Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.fail(new Error("no I-4 shutdown")) })
        )
        return out
      })

    const program = Effect.gen(function* () {
      yield* boot((client) =>
        Effect.gen(function* () {
          const { project } = yield* client.ProjectCreate({ name: "persist", ensure: false })
          yield* client.ProjectRename({ id: project.id, name: "persist-renamed" })
          yield* client.ProjectArchive({ id: project.id })
          yield* client.ProjectSetMetadata({ id: project.id, description: "kept", tags: ["t1"] })
          return project.id
        })
      )
      return yield* boot((client) => client.ProjectList({ includeArchived: true }))
    }).pipe(Effect.scoped, Effect.provide(ProcessServices.layer), Effect.provide(Layer.succeed(AppContext, makeTestAppContext(path, dir))))

    const listed = (yield* (program)) as {
      projects: ReadonlyArray<{
        name: string
        archived: boolean
        description: string | null
        tags: ReadonlyArray<string>
      }>
    }
    expect(listed.projects).toHaveLength(1)
    expect(listed.projects[0]).toMatchObject({ name: "persist-renamed", archived: true, description: "kept" })
    expect([...listed.projects[0]!.tags]).toEqual(["t1"])
  }))

  it.live("a deleted project stays gone, a renamed+moved one persists after restart",  () => Effect.gen(function*() {
    const path = yield* Path.Path.pipe(Effect.provide(NodeServices.layer))
    const dir = yield* makeTestDirectory('expand-durability-restart-')
    const dbPath = path.join(dir, "events.db")
    const workdir = yield* makeTestDirectory("expand-durable-dir-")
    const boot = (
      use: (
        c: import("@expand/client-ts").ExpandRpcClientApi
      ) => Effect.Effect<unknown, unknown, never>
    ) =>
      Effect.gen(function* () {
        const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
        yield* awaitEndpointUp
        const out = yield* withClient(nodeAdapter, use)
        yield* Fiber.join(serverFiber).pipe(
          Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.fail(new Error("no I-4 shutdown")) })
        )
        return out
      })

    const program = Effect.gen(function* () {
      const ids = yield* boot((client) =>
        Effect.gen(function* () {
          const keep = (yield* client.ProjectCreate({ name: "keeper", ensure: false })).project
          yield* client.ProjectRename({ id: keep.id, name: "keeper-renamed" })
          yield* client.ProjectChangeDirectory({ id: keep.id, directory: workdir })
          const doomed = (yield* client.ProjectCreate({ name: "doomed", ensure: false })).project
          yield* client.ProjectDelete({ id: doomed.id })
          return { keepId: keep.id, doomedId: doomed.id }
        })
      )
      const listed = yield* boot((client) => client.ProjectList({ includeArchived: true }))
      return { ids, listed }
    }).pipe(Effect.scoped, Effect.provide(ProcessServices.layer), Effect.provide(Layer.succeed(AppContext, makeTestAppContext(path, dir))))

    const r = (yield* (program)) as {
      ids: { keepId: string; doomedId: string }
      listed: { projects: ReadonlyArray<{ id: string; name: string; directory: string | null }> }
    }
    expect(r.listed.projects).toHaveLength(1)
    const survivor = r.listed.projects[0]!
    expect(survivor.id).toBe(r.ids.keepId)
    expect(survivor.name).toBe("keeper-renamed")
    expect(survivor.directory).toBe(workdir)
    expect(r.listed.projects.some((p) => p.id === r.ids.doomedId)).toBe(false)
  }))

  it.live("persists a snapshot that the reboot reads (snapshot seq matches the log)",  () => Effect.gen(function*() {
    const path = yield* Path.Path.pipe(Effect.provide(NodeServices.layer))
    const dir = yield* makeTestDirectory('expand-durability-restart-')
    const dbPath = path.join(dir, "events.db")
    const boot = (
      use: (c: import("@expand/client-ts").ExpandRpcClientApi) => Effect.Effect<unknown, unknown, never>
    ) =>
      Effect.gen(function* () {
        const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
        yield* awaitEndpointUp
        const out = yield* withClient(nodeAdapter, use)
        yield* Fiber.join(serverFiber).pipe(
          Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.fail(new Error("no I-4 shutdown")) })
        )
        return out
      })

    const program = Effect.gen(function* () {
      yield* boot((client) =>
        Effect.gen(function* () {
          const { project } = yield* client.ProjectCreate({ name: "snap-a", ensure: false })
          yield* client.ProjectCreate({ name: "snap-b", ensure: false })
          yield* client.ProjectRename({ id: project.id, name: "snap-a2" })
        })
      )
      return yield* boot((client) => client.ProjectList({ includeArchived: true }))
    }).pipe(Effect.scoped, Effect.provide(ProcessServices.layer), Effect.provide(Layer.succeed(AppContext, makeTestAppContext(path, dir))))

    const listed = (yield* (program)) as { seq: number; projects: ReadonlyArray<{ name: string }> }
    expect(listed.seq).toBe(3)
    expect(listed.projects.map((p) => p.name).sort()).toEqual(["snap-a2", "snap-b"])
  }))
})

const makeTestDirectory = (prefix: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix })),
    Effect.provide(NodeServices.layer)
  )

const makeTestAppContext = (path: Path.Path, dataDir: string) =>
  makeAppContext(path, { homeDir: dataDir, cwd: dataDir, dataDir })
