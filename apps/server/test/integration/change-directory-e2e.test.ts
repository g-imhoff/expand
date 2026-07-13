import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Effect, Fiber, Option, Schedule, Stream, Layer } from "effect"
import { NodeServices } from "@effect/platform-node"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runServer } from "@expand/server/composition/app"
import { withClient } from "@expand/client-ts"
import { makeNodeAdapter } from "@expand/client-ts/adapters/node"
import { readEndpoint } from "@expand/client-ts"
import { AppContext, makeAppContext } from "@expand/contracts/app-context"

const nodeAdapter = makeNodeAdapter({
  backendCommand: [process.execPath, "--import", "tsx", join(process.cwd(), "apps/server/main.ts")]
})

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "expand-cd-e2e-"))
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

describe.sequential("change-directory end-to-end", () => {
  it("change-directory commits, broadcasts ProjectDirectoryChanged, and survives a re-fold", async () => {
    const program = Effect.gen(function* () {
      const dbPath = join(dir, "events.db")
      const target = mkdtempSync(join(tmpdir(), "expand-cd-tgt-"))
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
      rmSync(target, { recursive: true, force: true })
      return out
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.provide(Layer.succeed(AppContext, makeAppContext(dir))))
    const r = await Effect.runPromise(program)
    expect(r.moved.directory).toBe(r.listed.projects[0]?.directory)
    expect(Option.isSome(r.event) && r.event.value.event._tag === "ProjectDirectoryChanged").toBe(true)
    expect(r.listed.projects[0]?.directory).toBe(r.moved.directory)
  })

  it("change-directory to a relative path fails with ProjectDirectoryInvalid over the wire", async () => {
    const program = Effect.gen(function* () {
      const serverFiber = yield* Effect.forkChild(runServer({ dbPath: join(dir, "events.db") }))
      yield* awaitEndpointUp
      const result = yield* withClient(nodeAdapter, (client) =>
        Effect.gen(function* () {
          const created = yield* client.ProjectCreate({ name: "cdbad", ensure: false })
          return yield* client.ProjectChangeDirectory({ id: created.project.id, directory: "rel/dir" }).pipe(Effect.result)
        })
      )
      yield* Fiber.interrupt(serverFiber)
      return result
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.provide(Layer.succeed(AppContext, makeAppContext(dir))))
    const exit = await Effect.runPromise(program)
    expect((exit as { failure: { _tag: string; reason: string } }).failure._tag).toBe("ProjectDirectoryInvalid")
  })
})
