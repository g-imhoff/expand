import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Effect, Fiber, Option, Schedule } from "effect"
import { BunServices } from "@effect/platform-bun"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runServer } from "@expand/server/composition/app"
import { withClient } from "@expand/client-core"
import { bunAdapter } from "@expand/client-core/adapters/bun"
import { readEndpoint } from "@expand/client-core/discovery"
import { makeTestAppContext } from "@expand/contracts/app-context.testkit"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "expand-conc-"))
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

describe.sequential("project operations under concurrency", () => {
  it("name-uniqueness guard rejects a SEQUENTIAL re-use with ProjectNameConflict", async () => {
    const program = Effect.gen(function* () {
      const dbPath = join(dir, "events.db")
      const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
      yield* awaitEndpointUp
      const out = yield* withClient(bunAdapter, (client) =>
        Effect.gen(function* () {
          const a = (yield* client.ProjectCreate({ name: "alpha", ensure: false })).project
          const b = (yield* client.ProjectCreate({ name: "beta", ensure: false })).project
          const first = yield* client.ProjectRename({ id: a.id, name: "merged" }).pipe(Effect.result)
          const second = yield* client.ProjectRename({ id: b.id, name: "merged" }).pipe(Effect.result)
          const listed = yield* client.ProjectList({ includeArchived: true })
          return { first, second, listed, aId: a.id }
        })
      )
      yield* Fiber.interrupt(serverFiber)
      return out
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.provide(makeTestAppContext(dir).layer))
    const r = (await Effect.runPromise(program)) as {
      first: { _tag: string }
      second: { _tag: string; failure?: { _tag: string } }
      listed: { projects: ReadonlyArray<{ id: string; name: string }> }
      aId: string
    }
    expect(r.first._tag).toBe("Success")
    expect(r.second._tag).toBe("Failure")
    expect(r.second.failure?._tag).toBe("ProjectNameConflict")
    const holders = r.listed.projects.filter((p) => p.name === "merged")
    expect(holders).toHaveLength(1)
    expect(holders[0]!.id).toBe(r.aId)
  })

  it("concurrent rename to the same name has exactly one winner", async () => {
    const program = Effect.gen(function* () {
      const dbPath = join(dir, "events.db")
      const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
      yield* awaitEndpointUp
      const out = yield* withClient(bunAdapter, (client) =>
        Effect.gen(function* () {
          const a = (yield* client.ProjectCreate({ name: "alpha", ensure: false })).project
          const b = (yield* client.ProjectCreate({ name: "beta", ensure: false })).project
          const results = yield* Effect.all(
            [client.ProjectRename({ id: a.id, name: "merged" }).pipe(Effect.result),
             client.ProjectRename({ id: b.id, name: "merged" }).pipe(Effect.result)],
            { concurrency: "unbounded" }
          )
          const listed = yield* client.ProjectList({ includeArchived: true })
          return { results, listed, aId: a.id, bId: b.id }
        })
      )
      yield* Fiber.interrupt(serverFiber)
      return out
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.provide(makeTestAppContext(dir).layer))
    const r = (await Effect.runPromise(program)) as {
      results: ReadonlyArray<{ _tag: string; failure?: { _tag: string } }>
      listed: { projects: ReadonlyArray<{ id: string; name: string }> }
      aId: string
      bId: string
    }
    expect(r.results).toHaveLength(2)
    expect(r.results.filter((x) => x._tag === "Success")).toHaveLength(1)
    expect(r.listed.projects).toHaveLength(2)
    const ids = r.listed.projects.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(ids)).toEqual(new Set([r.aId, r.bId]))
    const holders = r.listed.projects.filter((p) => p.name === "merged")
    expect(holders).toHaveLength(1)
    const loser = r.results.find((x) => x._tag === "Failure")
    expect(loser?.failure?._tag).toBe("ProjectNameConflict")
  })

  it("a deleted (tombstoned) project never resurrects: restore fails ProjectNotFound", async () => {
    const program = Effect.gen(function* () {
      const dbPath = join(dir, "events.db")
      const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
      yield* awaitEndpointUp
      const out = yield* withClient(bunAdapter, (client) =>
        Effect.gen(function* () {
          const { project } = yield* client.ProjectCreate({ name: "doomed", ensure: false })
          yield* client.ProjectArchive({ id: project.id })
          yield* client.ProjectDelete({ id: project.id })
          const restore = yield* client.ProjectRestore({ id: project.id }).pipe(Effect.result)
          const listed = yield* client.ProjectList({ includeArchived: true })
          return { restore, listed }
        })
      )
      yield* Fiber.interrupt(serverFiber)
      return out
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.provide(makeTestAppContext(dir).layer))
    const r = (await Effect.runPromise(program)) as {
      restore: { _tag: string; failure?: { _tag: string } }
      listed: { projects: ReadonlyArray<unknown> }
    }
    expect(r.restore._tag).toBe("Failure")
    expect(r.restore.failure?._tag).toBe("ProjectNotFound")
    expect(r.listed.projects).toEqual([])
  })

  it("directory-uniqueness guard rejects a SEQUENTIAL re-use with ProjectDirectoryConflict", async () => {
    const shared = mkdtempSync(join(tmpdir(), "expand-shared-seq-"))
    const program = Effect.gen(function* () {
      const dbPath = join(dir, "events.db")
      const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
      yield* awaitEndpointUp
      const out = yield* withClient(bunAdapter, (client) =>
        Effect.gen(function* () {
          const a = (yield* client.ProjectCreate({ name: "a", ensure: false })).project
          const b = (yield* client.ProjectCreate({ name: "b", ensure: false })).project
          const first = yield* client.ProjectChangeDirectory({ id: a.id, directory: shared }).pipe(Effect.result)
          const second = yield* client.ProjectChangeDirectory({ id: b.id, directory: shared }).pipe(Effect.result)
          const listed = yield* client.ProjectList({ includeArchived: true })
          return { first, second, listed, aId: a.id }
        })
      )
      yield* Fiber.interrupt(serverFiber)
      return out
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.provide(makeTestAppContext(dir).layer))
    const r = (await Effect.runPromise(program)) as {
      first: { _tag: string }
      second: { _tag: string; failure?: { _tag: string } }
      listed: { projects: ReadonlyArray<{ id: string; directory: string | null }> }
      aId: string
    }
    expect(r.first._tag).toBe("Success")
    expect(r.second._tag).toBe("Failure")
    expect(r.second.failure?._tag).toBe("ProjectDirectoryConflict")
    const holders = r.listed.projects.filter((p) => p.directory === shared)
    expect(holders).toHaveLength(1)
    expect(holders[0]!.id).toBe(r.aId)
    rmSync(shared, { recursive: true, force: true })
  })

  it("concurrent ChangeDirectory on the same dir has exactly one winner", async () => {
    const shared = mkdtempSync(join(tmpdir(), "expand-shared-"))
    const program = Effect.gen(function* () {
      const dbPath = join(dir, "events.db")
      const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
      yield* awaitEndpointUp
      const out = yield* withClient(bunAdapter, (client) =>
        Effect.gen(function* () {
          const a = (yield* client.ProjectCreate({ name: "a", ensure: false })).project
          const b = (yield* client.ProjectCreate({ name: "b", ensure: false })).project
          const results = yield* Effect.all(
            [client.ProjectChangeDirectory({ id: a.id, directory: shared }).pipe(Effect.result),
             client.ProjectChangeDirectory({ id: b.id, directory: shared }).pipe(Effect.result)],
            { concurrency: "unbounded" }
          )
          const listed = yield* client.ProjectList({ includeArchived: true })
          return { results, listed, aId: a.id, bId: b.id }
        })
      )
      yield* Fiber.interrupt(serverFiber)
      return out
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.provide(makeTestAppContext(dir).layer))
    const r = (await Effect.runPromise(program)) as {
      results: ReadonlyArray<{ _tag: string }>
      listed: { projects: ReadonlyArray<{ id: string; directory: string | null }> }
      aId: string
      bId: string
    }
    expect(r.results).toHaveLength(2)
    expect(r.listed.projects).toHaveLength(2)
    const committed = r.results.filter((x) => x._tag === "Success")
    expect(committed).toHaveLength(1)
    const holders = r.listed.projects.filter((p) => p.directory === shared)
    expect(holders).toHaveLength(1)
    rmSync(shared, { recursive: true, force: true })
  })
})
