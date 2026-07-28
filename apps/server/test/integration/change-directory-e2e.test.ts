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

describe.sequential("change-directory end-to-end", () => {
  it.live("change-directory commits, broadcasts ProjectDirectoryChanged, and survives a re-fold",  () => Effect.gen(function*() {
    const path = yield* Path.Path.pipe(Effect.provide(NodeServices.layer))
    const dir = yield* makeTestDirectory('expand-change-directory-e2e-')
    const program = Effect.gen(function* () {
      const dbPath = path.join(dir, "events.db")
      const target = yield* makeTestDirectory("expand-cd-tgt-")
      const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
      yield* awaitEndpointUp
      const out = yield* withClient(nodeAdapter, (client) =>
        Effect.gen(function* () {
          const created = yield* client.ProjectCreate({ name: "cde2e", ensure: false })
          const head = yield* Effect.forkChild(Stream.runHead(Stream.take(client.Events({}), 1)))
          yield* Effect.sleep("150 millis")
          const moved = yield* client.ProjectChangeDirectory({ id: created.project.id, directory: target })
          const event = yield* Fiber.join(head)
          const listed = yield* client.ProjectList({})
          return { created, moved, event, listed }
        })
      )
      yield* Fiber.interrupt(serverFiber)
      return out
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(ProcessServices.layer, Layer.succeed(AppContext, makeTestAppContext(path, dir)))))
    const r = yield* (program)
    expect(r.moved.directory).toBe(r.listed.projects[0]?.directory)
    expect(Option.isSome(r.event) && r.event.value.event._tag === "ProjectDirectoryChanged").toBe(true)
    expect(r.listed.projects[0]?.directory).toBe(r.moved.directory)
  }))

  it.live("change-directory to a relative path fails with ProjectDirectoryInvalid over the wire",  () => Effect.gen(function*() {
    const path = yield* Path.Path.pipe(Effect.provide(NodeServices.layer))
    const dir = yield* makeTestDirectory('expand-change-directory-e2e-')
    const program = Effect.gen(function* () {
      const serverFiber = yield* Effect.forkChild(runServer({ dbPath: path.join(dir, "events.db") }))
      yield* awaitEndpointUp
      const result = yield* withClient(nodeAdapter, (client) =>
        Effect.gen(function* () {
          const created = yield* client.ProjectCreate({ name: "cdbad", ensure: false })
          return yield* client.ProjectChangeDirectory({ id: created.project.id, directory: "rel/dir" }).pipe(Effect.result)
        })
      )
      yield* Fiber.interrupt(serverFiber)
      return result
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(ProcessServices.layer, Layer.succeed(AppContext, makeTestAppContext(path, dir)))))
    const exit = yield* (program)
    expect((exit as { failure: { _tag: string; reason: string } }).failure._tag).toBe("ProjectDirectoryInvalid")
  }))
})

const makeTestDirectory = (prefix: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix })),
    Effect.provide(NodeServices.layer)
  )

const makeTestAppContext = (path: Path.Path, dataDir: string) =>
  makeAppContext(path, { homeDir: dataDir, cwd: dataDir, dataDir })
