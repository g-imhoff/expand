import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Effect, Fiber, FileSystem, Option, Schedule, Stream } from "effect"
import { BunServices } from "@effect/platform-bun"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runServer } from "@yodea/server/composition/app"
import { withClient } from "@yodea/client-core"
import { bunAdapter } from "@yodea/client-core/adapters/bun"
import { readEndpoint } from "@yodea/client-core/discovery"
import { endpointFilePath } from "@yodea/contracts/endpoint"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yodea-e2e-"))
  process.env.YODEA_ENDPOINT_FILE = join(dir, "server.json")
})
afterEach(() => {
  delete process.env.YODEA_ENDPOINT_FILE
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

describe.sequential("end-to-end lifecycle", () => {
  it("boots, serves RPCs over WebSocket, and shuts down when the last client leaves", async () => {
    const program = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dbPath = join(dir, "events.db")
      const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))

      yield* awaitEndpointUp
      const upDuring = yield* fs.exists(endpointFilePath())

      const outcome = yield* withClient(bunAdapter, (client) =>
        Effect.gen(function* () {
          const health = yield* client.Health()
          const created = yield* client.ProjectCreate({ name: "E2E", ensure: false })
          const listed = yield* client.ProjectList({})
          return { health, created, listed }
        })
      )

      yield* Fiber.join(serverFiber).pipe(
        Effect.timeoutOrElse({
          duration: "5 seconds",
          orElse: () => Effect.fail(new Error("server did not shut down after last client left (I-4)"))
        })
      )
      const upAfter = yield* fs.exists(endpointFilePath())
      return { upDuring, upAfter, outcome }
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer))

    const r = await Effect.runPromise(program)
    expect(r.upDuring).toBe(true)
    expect(r.outcome.health).toBe("ok")
    expect(r.outcome.created.project.name).toBe("E2E")
    expect(r.outcome.listed).toEqual([r.outcome.created.project])
    expect(r.upAfter).toBe(false)
  })

  it("archive hides from default list, restore brings it back, ProjectNotFound on bogus id", async () => {
    const program = Effect.gen(function* () {
      const dbPath = join(dir, "events.db")
      const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
      yield* awaitEndpointUp
      const outcome = yield* withClient(bunAdapter, (client) =>
        Effect.gen(function* () {
          const { project } = yield* client.ProjectCreate({ name: "arch-e2e", ensure: false })
          const head = yield* Effect.forkChild(Stream.runHead(Stream.take(client.Events(), 1)))
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
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer))
    const r = await Effect.runPromise(program)
    expect(Option.isSome(r.archivedEvent)).toBe(true)
    if (Option.isSome(r.archivedEvent)) {
      expect(r.archivedEvent.value._tag).toBe("ProjectArchived")
    }
    expect(r.all.find((p) => p.id === r.project.id)?.archived).toBe(true)
    expect(r.def.some((p) => p.id === r.project.id)).toBe(false)
    expect(r.restored.archived).toBe(false)
    expect((r.missing as { failure: { _tag: string } }).failure._tag).toBe("ProjectNotFound")
  })

  it("delivers live domain events over the Events stream", async () => {
    const program = Effect.gen(function* () {
      const dbPath = join(dir, "events.db")
      const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
      yield* awaitEndpointUp

      const observed = yield* withClient(bunAdapter, (client) =>
        Effect.gen(function* () {
          const head = yield* Effect.forkChild(Stream.runHead(Stream.take(client.Events(), 1)))
          yield* Effect.sleep("150 millis")
          yield* client.ProjectCreate({ name: "live", ensure: false })
          return yield* Fiber.join(head)
        })
      )

      yield* Fiber.interrupt(serverFiber)
      return observed
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer))

    const observed = await Effect.runPromise(program)
    expect(Option.isSome(observed)).toBe(true)
    if (Option.isSome(observed)) {
      expect(observed.value._tag).toBe("ProjectCreated")
      if (observed.value._tag === "ProjectCreated") {
        expect(observed.value.name).toBe("live")
      }
    }
  })
})
