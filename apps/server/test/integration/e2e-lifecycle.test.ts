import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Path, Fiber, Option, Schedule, Stream, Layer } from "effect"
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

describe.sequential("end-to-end lifecycle", () => {
  it.live("boots, serves RPCs over WebSocket, and shuts down when the last client leaves",  () => Effect.gen(function*() {
    const path = yield* Path.Path.pipe(Effect.provide(NodeServices.layer))
    const dir = yield* makeTestDirectory('expand-e2e-lifecycle-')
    const program = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dbPath = path.join(dir, "events.db")
      const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))

      yield* awaitEndpointUp
      const upDuring = yield* fs.exists(makeTestAppContext(path, dir).paths.endpointFile)

      const outcome = yield* withClient(nodeAdapter, (client) =>
        Effect.gen(function* () {
          const health = yield* client.Health()
          const created = yield* client.ProjectCreate({ name: "e2e", ensure: false })
          const listed = yield* client.ProjectList({})
          return { health, created, listed }
        })
      )

      yield* Fiber.join(serverFiber).pipe(
        Effect.timeoutOrElse({
          duration: "5 seconds",
          orElse: () => Effect.fail("server did not shut down after last client left (I-4)")
        })
      )
      const upAfter = yield* fs.exists(makeTestAppContext(path, dir).paths.endpointFile)
      return { upDuring, upAfter, outcome }
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(ProcessServices.layer, Layer.succeed(AppContext, makeTestAppContext(path, dir)))))

    const r = yield* (program)
    expect(r.upDuring).toBe(true)
    expect(r.outcome.health).toBe("ok")
    expect(r.outcome.created.project.name).toBe("e2e")
    expect(r.outcome.listed.projects).toEqual([r.outcome.created.project])
    expect(r.upAfter).toBe(false)
  }))

  it.live("archive hides from default list, restore brings it back, ProjectNotFound on bogus id",  () => Effect.gen(function*() {
    const path = yield* Path.Path.pipe(Effect.provide(NodeServices.layer))
    const dir = yield* makeTestDirectory('expand-e2e-lifecycle-')
    const program = Effect.gen(function* () {
      const dbPath = path.join(dir, "events.db")
      const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
      yield* awaitEndpointUp
      const outcome = yield* withClient(nodeAdapter, (client) =>
        Effect.gen(function* () {
          const { project } = yield* client.ProjectCreate({ name: "arch-e2e", ensure: false })
          const head = yield* Effect.forkChild(Stream.runHead(Stream.take(client.Events({}), 1)))
          yield* Effect.sleep("150 millis")
          yield* client.ProjectArchive({ id: project.id })
          const archivedEvent = yield* Fiber.join(head)
          const all = yield* client.ProjectList({ includeArchived: true })
          const def = yield* client.ProjectList({})
          const restored = yield* client.ProjectRestore({ id: project.id })
          const missing = yield* client.ProjectArchive({ id: "00000000-0000-4000-8000-000000000000" }).pipe(Effect.result)
          return { project, archivedEvent, all, def, restored, missing }
        })
      )
      yield* Fiber.interrupt(serverFiber)
      return outcome
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(ProcessServices.layer, Layer.succeed(AppContext, makeTestAppContext(path, dir)))))
    const r = yield* (program)
    expect(Option.isSome(r.archivedEvent)).toBe(true)
    if (Option.isSome(r.archivedEvent)) {
      expect(r.archivedEvent.value.event._tag).toBe("ProjectArchived")
    }
    expect(r.all.projects.find((p) => p.id === r.project.id)?.archived).toBe(true)
    expect(r.def.projects.some((p) => p.id === r.project.id)).toBe(false)
    expect(r.restored.archived).toBe(false)
    expect((r.missing as { failure: { _tag: string } }).failure._tag).toBe("ProjectNotFound")
  }))

  it.live("delivers live domain events over the Events stream",  () => Effect.gen(function*() {
    const path = yield* Path.Path.pipe(Effect.provide(NodeServices.layer))
    const dir = yield* makeTestDirectory('expand-e2e-lifecycle-')
    const program = Effect.gen(function* () {
      const dbPath = path.join(dir, "events.db")
      const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
      yield* awaitEndpointUp

      const observed = yield* withClient(nodeAdapter, (client) =>
        Effect.gen(function* () {
          const head = yield* Effect.forkChild(Stream.runHead(Stream.take(client.Events({}), 1)))
          yield* Effect.sleep("150 millis")
          yield* client.ProjectCreate({ name: "live", ensure: false })
          return yield* Fiber.join(head)
        })
      )

      yield* Fiber.interrupt(serverFiber)
      return observed
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(ProcessServices.layer, Layer.succeed(AppContext, makeTestAppContext(path, dir)))))

    const observed = yield* (program)
    expect(Option.isSome(observed)).toBe(true)
    if (Option.isSome(observed)) {
      expect(observed.value.event._tag).toBe("ProjectCreated")
      if (observed.value.event._tag === "ProjectCreated") {
        expect(observed.value.event.name).toBe("live")
      }
    }
  }))
})

const makeTestDirectory = (prefix: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix })),
    Effect.provide(NodeServices.layer)
  )

const makeTestAppContext = (path: Path.Path, dataDir: string) =>
  makeAppContext(path, { homeDir: dataDir, cwd: dataDir, dataDir })
