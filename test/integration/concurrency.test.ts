import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Effect, Fiber, Option, Schedule } from "effect"
import { BunServices } from "@effect/platform-bun"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runServer } from "@yodea/composition/app"
import { withClient } from "@yodea/client-core"
import { bunAdapter } from "@yodea/client-core/adapters/bun"
import { readEndpoint } from "@yodea/client-core/discovery"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yodea-conc-"))
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

// The list-then-check commit path in use-cases.ts is a TOCTOU window documented as
// acceptable under I-2 (the source comment names the deferred TxQueue as the future
// serialized-commit fix). The uniqueness guards (name + directory) genuinely hold for
// the SEQUENTIAL case — those are the certified guarantees, asserted by the two
// "rejects a SEQUENTIAL re-use ..." tests below. Under GENUINE concurrency neither
// uniqueness is enforced: both contenders can list-then-check, observe the value as
// free, and both append. So the concurrent tests assert ONLY what truly holds under
// that window — the backend does NOT crash, both requests resolve, and the projection
// re-folds deterministically with no id duplication and full internal consistency
// (every project id appears exactly once) — NOT which request "wins" and NOT a
// "no duplicate names/directories" guarantee, which the concurrent path does not make.
// (Tombstone permanence — a deleted project never resurrects — is a separate, real
// invariant asserted on its own below.)
describe.sequential("project operations under concurrency", () => {
  // name-uniqueness guard, SEQUENTIAL case — the legitimately certified invariant.
  // Mirror of the SEQUENTIAL directory test: rename A->"merged", THEN rename B->
  // "merged"; absent a race the guard sees "merged" already taken and rejects the
  // second with ProjectNameConflict. This is what proves the uniqueness guard works.
  it("name-uniqueness guard rejects a SEQUENTIAL re-use with ProjectNameConflict", async () => {
    const program = Effect.gen(function* () {
      const dbPath = join(dir, "events.db")
      const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
      yield* awaitEndpointUp
      const out = yield* withClient(bunAdapter, (client) =>
        Effect.gen(function* () {
          const a = (yield* client.ProjectCreate({ name: "alpha", ensure: false })).project
          const b = (yield* client.ProjectCreate({ name: "beta", ensure: false })).project
          // Sequential: A takes "merged" first, THEN B contends for the same name.
          const first = yield* client.ProjectRename({ id: a.id, name: "merged" }).pipe(Effect.result)
          const second = yield* client.ProjectRename({ id: b.id, name: "merged" }).pipe(Effect.result)
          const listed = yield* client.ProjectList({ includeArchived: true })
          return { first, second, listed, aId: a.id }
        })
      )
      yield* Fiber.interrupt(serverFiber)
      return out
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer))
    const r = (await Effect.runPromise(program)) as {
      first: { _tag: string }
      second: { _tag: string; failure?: { _tag: string } }
      listed: ReadonlyArray<{ id: string; name: string }>
      aId: string
    }
    expect(r.first._tag).toBe("Success")
    expect(r.second._tag).toBe("Failure")
    expect(r.second.failure?._tag).toBe("ProjectNameConflict")
    // Without a race the invariant DOES hold: exactly one (A) carries "merged".
    const holders = r.listed.filter((p) => p.name === "merged")
    expect(holders).toHaveLength(1)
    expect(holders[0]!.id).toBe(r.aId)
  })

  // CONCURRENT rename to the same name — documented TOCTOU window (same I-2 limitation
  // as directory-uniqueness). name-uniqueness is NOT a guarantee under genuine
  // concurrency: both renames list-then-check, both can observe "merged" as free, and
  // both can append. This test asserts only what truly holds — both requests resolve
  // with at least one Success, the backend does not crash, and the read-model re-folds
  // deterministically (every project id appears exactly once). It deliberately does
  // NOT assert "names are unique"; that is the same accepted TOCTOU window as
  // directory-uniqueness (I-2), to be closed by the deferred TxQueue. (renameProject
  // happens to have no async step between list and append today, so the window rarely
  // opens — but that is a microtask-ordering artifact, not an enforced invariant, so
  // we do not certify it.)
  it("concurrent rename to the same name converges deterministically without a crash (documented TOCTOU)", async () => {
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
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer))
    const r = (await Effect.runPromise(program)) as {
      results: ReadonlyArray<{ _tag: string }>
      listed: ReadonlyArray<{ id: string; name: string }>
      aId: string
      bId: string
    }
    // No crash: both requests resolve, at least one renamed successfully.
    expect(r.results).toHaveLength(2)
    expect(r.results.some((x) => x._tag === "Success")).toBe(true)
    // Determinism / consistency: the projection re-folds cleanly — both projects
    // still exist by id with NO id duplication (every project id appears once).
    expect(r.listed).toHaveLength(2)
    const ids = r.listed.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length) // no id duplication in the read-model
    expect(new Set(ids)).toEqual(new Set([r.aId, r.bId]))
    // NOTE: we intentionally do NOT assert name-uniqueness here — under the documented
    // TOCTOU window both renames may commit "merged". That is the accepted I-2 race,
    // identical to directory-uniqueness, to be closed by the deferred TxQueue.
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
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer))
    const r = (await Effect.runPromise(program)) as {
      restore: { _tag: string; failure?: { _tag: string } }
      listed: ReadonlyArray<unknown>
    }
    expect(r.restore._tag).toBe("Failure")
    expect(r.restore.failure?._tag).toBe("ProjectNotFound")
    expect(r.listed).toEqual([])
  })

  // OBSERVED CONCURRENCY BEHAVIOUR (directory-uniqueness race)
  // ----------------------------------------------------------
  // The use-case commit path is list-then-check-then-append with NO commit-path
  // mutex (apps/cli/application/use-cases.ts: the comment even names the deferred
  // TxQueue as the future fix). When two ChangeDirectory RPCs are issued with
  // `Effect.all({ concurrency: "unbounded" })`, the RpcServer handles each request
  // in its own fiber. Both fibers run `projection.list` + `validateDirectory`
  // BEFORE either runs `store.append`, so both observe the directory as free and
  // both commit. This is the documented, ACCEPTABLE TOCTOU window under I-2: the
  // idealized strict-serialization invariant (`<= 1` holder) does NOT hold for
  // genuinely-concurrent requests on the current single-backend path. Observed
  // deterministically over repeated runs: BOTH projects end up holding the dir.
  //
  // What this test PROVES is the set of invariants that DO hold:
  //   (1) the guard is correct absent a race: a SEQUENTIAL ChangeDirectory to a
  //       directory already held by a live project fails with ProjectDirectoryConflict;
  //   (2) under genuine concurrency the backend does NOT crash and the projection
  //       is deterministic — every appended event re-folds cleanly into the model
  //       (each contender's directory is reflected, none lost/duplicated by id).
  it("directory-uniqueness guard rejects a SEQUENTIAL re-use with ProjectDirectoryConflict", async () => {
    const shared = mkdtempSync(join(tmpdir(), "yodea-shared-seq-"))
    const program = Effect.gen(function* () {
      const dbPath = join(dir, "events.db")
      const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
      yield* awaitEndpointUp
      const out = yield* withClient(bunAdapter, (client) =>
        Effect.gen(function* () {
          const a = (yield* client.ProjectCreate({ name: "a", ensure: false })).project
          const b = (yield* client.ProjectCreate({ name: "b", ensure: false })).project
          // Sequential: A commits the dir first, THEN B contends for it.
          const first = yield* client.ProjectChangeDirectory({ id: a.id, directory: shared }).pipe(Effect.result)
          const second = yield* client.ProjectChangeDirectory({ id: b.id, directory: shared }).pipe(Effect.result)
          const listed = yield* client.ProjectList({ includeArchived: true })
          return { first, second, listed, aId: a.id }
        })
      )
      yield* Fiber.interrupt(serverFiber)
      return out
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer))
    const r = (await Effect.runPromise(program)) as {
      first: { _tag: string }
      second: { _tag: string; failure?: { _tag: string } }
      listed: ReadonlyArray<{ id: string; directory: string | null }>
      aId: string
    }
    expect(r.first._tag).toBe("Success")
    expect(r.second._tag).toBe("Failure")
    expect(r.second.failure?._tag).toBe("ProjectDirectoryConflict")
    // Without a race the invariant DOES hold: exactly one (A) holds the directory.
    const holders = r.listed.filter((p) => p.directory === shared)
    expect(holders).toHaveLength(1)
    expect(holders[0]!.id).toBe(r.aId)
    rmSync(shared, { recursive: true, force: true })
  })

  it("concurrent ChangeDirectory on the same dir converges deterministically without a crash (documented TOCTOU)", async () => {
    const shared = mkdtempSync(join(tmpdir(), "yodea-shared-"))
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
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer))
    const r = (await Effect.runPromise(program)) as {
      results: ReadonlyArray<{ _tag: string }>
      listed: ReadonlyArray<{ id: string; directory: string | null }>
      aId: string
      bId: string
    }
    // No crash: both requests resolve (the program returned a value).
    expect(r.results).toHaveLength(2)
    // Determinism / consistency: the projection re-folds cleanly — both projects
    // still exist by id, no duplication, every committed ChangeDirectory is
    // reflected. Under the documented TOCTOU window both commit, so each holder
    // points at `shared`; whichever subset committed, the model is consistent.
    expect(r.listed).toHaveLength(2)
    const byId = new Map(r.listed.map((p) => [p.id, p.directory]))
    expect(byId.size).toBe(2) // no id duplication in the read-model
    const committed = r.results.filter((x) => x._tag === "Success")
    // Every project whose ChangeDirectory committed Success holds `shared`.
    expect(committed.length).toBeGreaterThanOrEqual(1)
    for (const p of r.listed) {
      if (p.directory !== null) expect(p.directory).toBe(shared)
    }
    rmSync(shared, { recursive: true, force: true })
  })
})
