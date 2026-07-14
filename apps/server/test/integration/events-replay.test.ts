import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Effect, Fiber, Option, Queue, Schedule, Layer } from "effect"
import { ProcessServices } from "@expand/server/node-process-control"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { runServer } from "@expand/server/composition/app"
import { withClient } from "@expand/client-ts"
import { makeNodeAdapter } from "@expand/client-ts/adapters/node"
import { readEndpoint } from "@expand/client-ts"
import { AppContext, makeAppContext } from "@expand/contracts/app-context"

const nodeAdapter = makeNodeAdapter({
  backendCommand: Effect.sync(() => ["node", "--import", "tsx", resolve("apps/server/main.ts")])
})

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "expand-replay-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const awaitEndpointUp = readEndpoint.pipe(
  Effect.flatMap((o) => (Option.isSome(o) ? Effect.void : Effect.fail("pending" as const))),
  Effect.retry(Schedule.spaced("25 millis")),
  Effect.timeoutOrElse({
    duration: "5 seconds",
    orElse: () => Effect.fail(new Error("server never advertised an endpoint (I-3)"))
  })
)

describe.sequential("Events replay with fromSeq", () => {
  it("replays the backlog strictly after the cursor, then continues live without duplicates", async () => {
    const program = Effect.gen(function* () {
      const dbPath = join(dir, "events.db")
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
    }).pipe(Effect.scoped, Effect.provide(ProcessServices.layer), Effect.provide(Layer.succeed(AppContext, makeTestAppContext(dir))))
    const r = await Effect.runPromise(program)
    expect(r.first.seq).toBe(2)
    expect(r.first.event._tag).toBe("ProjectCreated")
    if (r.first.event._tag === "ProjectCreated") expect(r.first.event.name).toBe("replay-b")
    expect(r.second.seq).toBe(3)
    expect(r.second.event._tag).toBe("ProjectRenamed")
  })

  it("fromSeq: 0 replays the entire backlog in order", async () => {
    const program = Effect.gen(function* () {
      const dbPath = join(dir, "events.db")
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
    }).pipe(Effect.scoped, Effect.provide(ProcessServices.layer), Effect.provide(Layer.succeed(AppContext, makeTestAppContext(dir))))
    const [e1, e2] = await Effect.runPromise(program)
    expect([e1.seq, e2.seq]).toEqual([1, 2])
    expect([e1.event._tag, e2.event._tag]).toEqual(["ProjectCreated", "ProjectCreated"])
  })
})

const makeTestAppContext = (dataDir: string) =>
  makeAppContext(
    { join, resolve },
    { homeDir: dataDir, cwd: dataDir, dataDir }
  )

function join(...paths: ReadonlyArray<string>): string {
  return resolve(...paths)
}
