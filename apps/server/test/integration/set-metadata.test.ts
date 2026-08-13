import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Path, Fiber, Option, Schedule, Stream, Layer } from "effect"
import { ProcessServices } from "@expand/server/runtime/node-process-control"
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

describe.sequential("end-to-end set-metadata", () => {
  it.live("replaces metadata, broadcasts ProjectMetadataChanged, lists it, surfaces ProjectNotFound, and survives a re-fold",  () => Effect.gen(function*() {
    const path = yield* Path.Path.pipe(Effect.provide(NodeServices.layer))
    const dir = yield* makeTestDirectory('expand-set-metadata-')
    const dbPath = path.join(dir, "events.db")

    const program = Effect.gen(function* () {
      const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
      yield* awaitEndpointUp
      const outcome = yield* withClient(nodeAdapter, (client) =>
        Effect.gen(function* () {
          const { project } = yield* client.ProjectCreate({ name: "e2emeta", ensure: false })
          const head = yield* Effect.forkChild(Stream.runHead(Stream.take(client.Events({}), 1)))
          yield* Effect.sleep("150 millis")
          const updated = yield* client.ProjectSetMetadata({ id: project.id, description: "e2e", tags: ["a", "a", "b"] })
          const metaEvent = yield* Fiber.join(head)
          const listed = yield* client.ProjectList({})
          const notFound = yield* client.ProjectSetMetadata({ id: "00000000-0000-4000-8000-000000000000", description: "x" }).pipe(Effect.result)
          return { project, updated, metaEvent, listed, notFound }
        })
      )
      yield* Fiber.interrupt(serverFiber)
      return outcome
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(ProcessServices.layer, Layer.succeed(AppContext, makeTestAppContext(path, dir)))))

    const r = yield* (program)

    expect(r.updated.id).toBe(r.project.id)
    expect(r.updated.description).toBe("e2e")
    expect(r.updated.tags).toEqual(["a", "b"])
    expect(r.updated.updatedAt > r.updated.createdAt).toBe(true)
    expect(Option.isSome(r.metaEvent)).toBe(true)
    if (Option.isSome(r.metaEvent)) {
      expect(r.metaEvent.value.event._tag).toBe("ProjectMetadataChanged")
    }
    expect(r.listed.projects.find((p) => p.id === r.project.id)?.description).toBe("e2e")
    expect((r.notFound as { failure: { _tag: string } }).failure._tag).toBe("ProjectNotFound")

    const durable = Effect.gen(function* () {
      const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
      yield* awaitEndpointUp
      const listed = yield* withClient(nodeAdapter, (client) => client.ProjectList({}))
      yield* Fiber.interrupt(serverFiber)
      return listed
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(ProcessServices.layer, Layer.succeed(AppContext, makeTestAppContext(path, dir)))))

    const listed2 = yield* (durable)
    const survived = listed2.projects.find((p) => p.id === r.project.id)
    expect(survived?.description).toBe("e2e")
    expect(survived?.tags).toEqual(["a", "b"])
  }))
})

const makeTestDirectory = (prefix: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix })),
    Effect.provide(NodeServices.layer)
  )

const makeTestAppContext = (path: Path.Path, dataDir: string) =>
  makeAppContext(path, { homeDir: dataDir, cwd: dataDir, dataDir })
