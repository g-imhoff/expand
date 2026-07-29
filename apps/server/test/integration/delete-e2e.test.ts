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
  Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.fail("server never advertised an endpoint") })
)

describe.sequential("project delete e2e", () => {
  it.live("deletes a project, emits ProjectDeleted, removes it from the list, and survives a restart",  () => Effect.gen(function*() {
    const path = yield* Path.Path.pipe(Effect.provide(NodeServices.layer))
    const dir = yield* makeTestDirectory('expand-delete-e2e-')
    const dbPath = path.join(dir, "events.db")
    const first = yield* (Effect.gen(function* () {
        const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
        yield* awaitEndpointUp
        const out = yield* withClient(nodeAdapter, (client) =>
          Effect.gen(function* () {
            const created = yield* client.ProjectCreate({ name: "gone", ensure: false })
            const head = yield* Effect.forkChild(
              Stream.runHead(Stream.take(Stream.filter(client.Events({}), (se) => se.event._tag === "ProjectDeleted"), 1))
            )
            yield* Effect.sleep("150 millis")
            const del = yield* client.ProjectDelete({ id: created.project.id })
            const event = yield* Fiber.join(head)
            const listed = yield* client.ProjectList({ includeArchived: true })
            return { id: created.project.id, del, event, listed }
          })
        )
        yield* Fiber.interrupt(serverFiber)
        return out
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(ProcessServices.layer, Layer.succeed(AppContext, makeTestAppContext(path, dir))))))
    expect(first.del).toEqual({ id: first.id, deleted: true })
    expect(Option.isSome(first.event)).toBe(true)
    expect(first.listed.projects.some((p) => p.id === first.id)).toBe(false)

    const afterRestart = yield* (Effect.gen(function* () {
        const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
        yield* awaitEndpointUp
        const listed = yield* withClient(nodeAdapter, (client) => client.ProjectList({ includeArchived: true }))
        yield* Fiber.interrupt(serverFiber)
        return listed
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(ProcessServices.layer, Layer.succeed(AppContext, makeTestAppContext(path, dir))))))
    expect(afterRestart.projects.some((p) => p.id === first.id)).toBe(false)
  }))
})

const makeTestDirectory = (prefix: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix })),
    Effect.provide(NodeServices.layer)
  )

const makeTestAppContext = (path: Path.Path, dataDir: string) =>
  makeAppContext(path, { homeDir: dataDir, cwd: dataDir, dataDir })
