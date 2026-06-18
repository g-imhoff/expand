import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Effect, Fiber, Option, Schedule, Queue } from "effect"
import { BunServices } from "@effect/platform-bun"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runServer } from "@yodea/server/composition/app"
import { withClient } from "@yodea/client-core"
import { bunAdapter } from "@yodea/client-core/adapters/bun"
import { readEndpoint } from "@yodea/client-core/discovery"
import { appContextLayer } from "@yodea/contracts/app-context"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yodea-ops-"))
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

describe.sequential("project operations over the wire", () => {
  it("drives every operation and observes each event live", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "yodea-projdir-"))
    const program = Effect.gen(function* () {
      const dbPath = join(dir, "events.db")
      const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
      yield* awaitEndpointUp

      const outcome = yield* withClient(bunAdapter, (client) =>
        Effect.gen(function* () {
          const events = yield* client.Events({}, { asQueue: true })
          yield* Effect.sleep("500 millis")

          const { project } = yield* client.ProjectCreate({ name: "ops", ensure: false })
          const renamed = yield* client.ProjectRename({ id: project.id, name: "ops-renamed" })
          const dirSet = yield* client.ProjectChangeDirectory({ id: project.id, directory: workdir })
          const archived = yield* client.ProjectArchive({ id: project.id })
          const restored = yield* client.ProjectRestore({ id: project.id })
          const meta = yield* client.ProjectSetMetadata({ id: project.id, description: "desc", tags: ["a", "b"] })
          const deleted = yield* client.ProjectDelete({ id: project.id })

          const tags: string[] = []
          for (let i = 0; i < 7; i++) tags.push((yield* Queue.take(events)).event._tag)

          const listed = yield* client.ProjectList({})
          return { renamed, dirSet, archived, restored, meta, deleted, tags, listed }
        })
      )
      yield* Fiber.interrupt(serverFiber)
      return outcome
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.provide(appContextLayer(dir)))

    const r = await Effect.runPromise(program)
    expect(r.renamed.name).toBe("ops-renamed")
    expect(r.dirSet.directory).toBe(workdir)
    expect(r.archived.archived).toBe(true)
    expect(r.restored.archived).toBe(false)
    expect(r.meta.description).toBe("desc")
    expect([...r.meta.tags]).toEqual(["a", "b"])
    expect(r.deleted).toEqual({ id: r.renamed.id, deleted: true })
    expect(r.tags).toEqual([
      "ProjectCreated", "ProjectRenamed", "ProjectDirectoryChanged",
      "ProjectArchived", "ProjectRestored", "ProjectMetadataChanged", "ProjectDeleted"
    ])
    expect(r.listed.projects).toEqual([])
    rmSync(workdir, { recursive: true, force: true })
  })

  it("rejects a non-absolute / non-existent directory with the typed error over the wire", async () => {
    const program = Effect.gen(function* () {
      const dbPath = join(dir, "events.db")
      const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
      yield* awaitEndpointUp
      const result = yield* withClient(bunAdapter, (client) =>
        Effect.gen(function* () {
          const { project } = yield* client.ProjectCreate({ name: "dirfail", ensure: false })
          return yield* client.ProjectChangeDirectory({ id: project.id, directory: "/definitely/not/here" }).pipe(Effect.result)
        })
      )
      yield* Fiber.interrupt(serverFiber)
      return result
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.provide(appContextLayer(dir)))
    const r = await Effect.runPromise(program)
    expect(r._tag).toBe("Failure")
    if (r._tag === "Failure") expect((r.failure as { _tag: string })._tag).toBe("ProjectDirectoryInvalid")
  })
})
