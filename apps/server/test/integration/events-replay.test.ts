import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Path, Fiber, Option, Queue, Schedule, Layer } from "effect"
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

describe.sequential("Events replay with fromSeq", () => {
  it.live("replays the backlog strictly after the cursor, then continues live without duplicates",  () => Effect.gen(function*() {
    const path = yield* Path.Path.pipe(Effect.provide(NodeServices.layer))
    const dir = yield* makeTestDirectory('expand-events-replay-')
    const program = Effect.gen(function* () {
      const dbPath = path.join(dir, "events.db")
      const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
      yield* awaitEndpointUp
      const out = yield* withClient(nodeAdapter, (client) =>
        Effect.gen(function* () {
          const a = (yield* client.ProjectCreate({ name: "replay-a", ensure: false })).project
          yield* client.ProjectCreate({ name: "replay-b", ensure: false })
          const events = yield* client.Events({ fromSeq: 1 }, { asQueue: true })
          const first = yield* Queue.take(events)
          yield* client.ProjectRename({ id: a.id, name: "replay-a2" })
          const second = yield* Queue.take(events)
          return { first, second }
        })
      )
      yield* Fiber.interrupt(serverFiber)
      return out
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(ProcessServices.layer, Layer.succeed(AppContext, makeTestAppContext(path, dir)))))
    const r = yield* (program)
    expect(r.first.seq).toBe(2)
    expect(r.first.event._tag).toBe("ProjectCreated")
    if (r.first.event._tag === "ProjectCreated") expect(r.first.event.name).toBe("replay-b")
    expect(r.second.seq).toBe(3)
    expect(r.second.event._tag).toBe("ProjectRenamed")
  }))

  it.live("fromSeq: 0 replays the entire backlog in order",  () => Effect.gen(function*() {
    const path = yield* Path.Path.pipe(Effect.provide(NodeServices.layer))
    const dir = yield* makeTestDirectory('expand-events-replay-')
    const program = Effect.gen(function* () {
      const dbPath = path.join(dir, "events.db")
      const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
      yield* awaitEndpointUp
      const out = yield* withClient(nodeAdapter, (client) =>
        Effect.gen(function* () {
          yield* client.ProjectCreate({ name: "full-a", ensure: false })
          yield* client.ProjectCreate({ name: "full-b", ensure: false })
          const events = yield* client.Events({ fromSeq: 0 }, { asQueue: true })
          const e1 = yield* Queue.take(events)
          const e2 = yield* Queue.take(events)
          return [e1, e2] as const
        })
      )
      yield* Fiber.interrupt(serverFiber)
      return out
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(ProcessServices.layer, Layer.succeed(AppContext, makeTestAppContext(path, dir)))))
    const [e1, e2] = yield* (program)
    expect([e1.seq, e2.seq]).toEqual([1, 2])
    expect([e1.event._tag, e2.event._tag]).toEqual(["ProjectCreated", "ProjectCreated"])
  }))
})

const makeTestDirectory = (prefix: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix })),
    Effect.provide(NodeServices.layer)
  )

const makeTestAppContext = (path: Path.Path, dataDir: string) =>
  makeAppContext(path, { homeDir: dataDir, cwd: dataDir, dataDir })
