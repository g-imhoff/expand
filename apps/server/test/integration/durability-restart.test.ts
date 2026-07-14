import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Effect, Fiber, Option, Schedule, Layer } from "effect"
import { NodeServices } from "@effect/platform-node"
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
  dir = mkdtempSync(join(tmpdir(), "expand-durable-"))
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

describe.sequential("durability across a backend restart", () => {
  it("re-folds all mutations after a full backend restart on the same db", async () => {
    const dbPath = join(dir, "events.db")
    const boot = (
      use: (
        c: import("@expand/client-ts").ExpandRpcClientApi
      ) => Effect.Effect<unknown, unknown, never>
    ) =>
      Effect.gen(function* () {
        const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
        yield* awaitEndpointUp
        const out = yield* withClient(nodeAdapter, use)
        yield* Fiber.join(serverFiber).pipe(
          Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.fail(new Error("no I-4 shutdown")) })
        )
        return out
      })

    const program = Effect.gen(function* () {
      yield* boot((client) =>
        Effect.gen(function* () {
          const { project } = yield* client.ProjectCreate({ name: "persist", ensure: false })
          yield* client.ProjectRename({ id: project.id, name: "persist-renamed" })
          yield* client.ProjectArchive({ id: project.id })
          yield* client.ProjectSetMetadata({ id: project.id, description: "kept", tags: ["t1"] })
          return project.id
        })
      )
      return yield* boot((client) => client.ProjectList({ includeArchived: true }))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.provide(Layer.succeed(AppContext, makeTestAppContext(dir))))

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
    const workdir = mkdtempSync(join(tmpdir(), "expand-durable-dir-"))
    const boot = (
      use: (
        c: import("@expand/client-ts").ExpandRpcClientApi
      ) => Effect.Effect<unknown, unknown, never>
    ) =>
      Effect.gen(function* () {
        const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
        yield* awaitEndpointUp
        const out = yield* withClient(nodeAdapter, use)
        yield* Fiber.join(serverFiber).pipe(
          Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.fail(new Error("no I-4 shutdown")) })
        )
        return out
      })

    const program = Effect.gen(function* () {
      const ids = yield* boot((client) =>
        Effect.gen(function* () {
          const keep = (yield* client.ProjectCreate({ name: "keeper", ensure: false })).project
          yield* client.ProjectRename({ id: keep.id, name: "keeper-renamed" })
          yield* client.ProjectChangeDirectory({ id: keep.id, directory: workdir })
          const doomed = (yield* client.ProjectCreate({ name: "doomed", ensure: false })).project
          yield* client.ProjectDelete({ id: doomed.id })
          return { keepId: keep.id, doomedId: doomed.id }
        })
      )
      const listed = yield* boot((client) => client.ProjectList({ includeArchived: true }))
      return { ids, listed }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.provide(Layer.succeed(AppContext, makeTestAppContext(dir))))

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

  it("persists a snapshot that the reboot reads (snapshot seq matches the log)", async () => {
    const dbPath = join(dir, "events.db")
    const boot = (
      use: (c: import("@expand/client-ts").ExpandRpcClientApi) => Effect.Effect<unknown, unknown, never>
    ) =>
      Effect.gen(function* () {
        const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
        yield* awaitEndpointUp
        const out = yield* withClient(nodeAdapter, use)
        yield* Fiber.join(serverFiber).pipe(
          Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.fail(new Error("no I-4 shutdown")) })
        )
        return out
      })

    const program = Effect.gen(function* () {
      yield* boot((client) =>
        Effect.gen(function* () {
          const { project } = yield* client.ProjectCreate({ name: "snap-a", ensure: false })
          yield* client.ProjectCreate({ name: "snap-b", ensure: false })
          yield* client.ProjectRename({ id: project.id, name: "snap-a2" })
        })
      )
      return yield* boot((client) => client.ProjectList({ includeArchived: true }))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.provide(Layer.succeed(AppContext, makeTestAppContext(dir))))

    const listed = (await Effect.runPromise(program)) as { seq: number; projects: ReadonlyArray<{ name: string }> }
    expect(listed.seq).toBe(3)
    expect(listed.projects.map((p) => p.name).sort()).toEqual(["snap-a2", "snap-b"])
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
