import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Effect, Fiber, Option, Schedule } from "effect"
import { BunServices } from "@effect/platform-bun"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ProjectName, Tag } from "@yodea/contracts/project"
import { runServer } from "@yodea/server/composition/app"
import { withClient } from "@yodea/client-core"
import { bunAdapter } from "@yodea/client-core/adapters/bun"
import { readEndpoint } from "@yodea/client-core/discovery"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yodea-durable-"))
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

describe.sequential("durability across a backend restart", () => {
  it("re-folds all mutations after a full backend restart on the same db", async () => {
    const dbPath = join(dir, "events.db")
    const boot = (
      use: (
        c: import("@yodea/client-core/rpc-client").YodeaRpcClientApi
      ) => Effect.Effect<unknown, unknown, never>
    ) =>
      Effect.gen(function* () {
        const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
        yield* awaitEndpointUp
        const out = yield* withClient(bunAdapter, use)
        yield* Fiber.join(serverFiber).pipe(
          Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.fail(new Error("no I-4 shutdown")) })
        )
        return out
      })

    const program = Effect.gen(function* () {
      yield* boot((client) =>
        Effect.gen(function* () {
          const { project } = yield* client.ProjectCreate({ name: ProjectName.make("persist"), ensure: false })
          yield* client.ProjectRename({ id: project.id, name: ProjectName.make("persist-renamed") })
          yield* client.ProjectArchive({ id: project.id })
          yield* client.ProjectSetMetadata({ id: project.id, description: "kept", tags: [Tag.make("t1")] })
          return project.id
        })
      )
      return yield* boot((client) => client.ProjectList({ includeArchived: true }))
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer))

    const listed = (await Effect.runPromise(program)) as {
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
  })

  it("a deleted project stays gone, a renamed+moved one persists after restart", async () => {
    const dbPath = join(dir, "events.db")
    const workdir = mkdtempSync(join(tmpdir(), "yodea-durable-dir-"))
    const boot = (
      use: (
        c: import("@yodea/client-core/rpc-client").YodeaRpcClientApi
      ) => Effect.Effect<unknown, unknown, never>
    ) =>
      Effect.gen(function* () {
        const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
        yield* awaitEndpointUp
        const out = yield* withClient(bunAdapter, use)
        yield* Fiber.join(serverFiber).pipe(
          Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.fail(new Error("no I-4 shutdown")) })
        )
        return out
      })

    const program = Effect.gen(function* () {
      const ids = yield* boot((client) =>
        Effect.gen(function* () {
          const keep = (yield* client.ProjectCreate({ name: ProjectName.make("keeper"), ensure: false })).project
          yield* client.ProjectRename({ id: keep.id, name: ProjectName.make("keeper-renamed") })
          yield* client.ProjectChangeDirectory({ id: keep.id, directory: workdir })
          const doomed = (yield* client.ProjectCreate({ name: ProjectName.make("doomed"), ensure: false })).project
          yield* client.ProjectDelete({ id: doomed.id })
          return { keepId: keep.id, doomedId: doomed.id }
        })
      )
      const listed = yield* boot((client) => client.ProjectList({ includeArchived: true }))
      return { ids, listed }
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer))

    const r = (await Effect.runPromise(program)) as {
      ids: { keepId: string; doomedId: string }
      listed: { projects: ReadonlyArray<{ id: string; name: string; directory: string | null }> }
    }
    expect(r.listed.projects).toHaveLength(1)
    const survivor = r.listed.projects[0]!
    expect(survivor.id).toBe(r.ids.keepId)
    expect(survivor.name).toBe("keeper-renamed")
    expect(survivor.directory).toBe(workdir)
    expect(r.listed.projects.some((p) => p.id === r.ids.doomedId)).toBe(false)
    rmSync(workdir, { recursive: true, force: true })
  })
})
