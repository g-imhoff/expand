import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Effect, Fiber, Option, Schedule, Stream } from "effect"
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
  dir = mkdtempSync(join(tmpdir(), "expand-meta-e2e-"))
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

describe.sequential("end-to-end set-metadata", () => {
  it("replaces metadata, broadcasts ProjectMetadataChanged, lists it, surfaces ProjectNotFound, and survives a re-fold", async () => {
    const dbPath = join(dir, "events.db")

    const program = Effect.gen(function* () {
      const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
      yield* awaitEndpointUp
      const outcome = yield* withClient(bunAdapter, (client) =>
        Effect.gen(function* () {
          const { project } = yield* client.ProjectCreate({ name: "e2emeta", ensure: false })
          const head = yield* Effect.forkChild(Stream.runHead(Stream.take(client.Events({}), 1)))
          yield* Effect.sleep("150 millis")
          const updated = yield* client.ProjectSetMetadata({ id: project.id, description: "e2e", tags: ["a", "a", "b"] })
          const metaEvent = yield* Fiber.join(head)
          const listed = yield* client.ProjectList({})
          const notFound = yield* client.ProjectSetMetadata({ id: "00000000-0000-4000-8000-000000000000", description: "x" }).pipe(Effect.result)
          return { project, updated, metaEvent, listed, notFound }
        })
      )
      yield* Fiber.interrupt(serverFiber)
      return outcome
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.provide(makeTestAppContext(dir).layer))

    const r = await Effect.runPromise(program)

    expect(r.updated.id).toBe(r.project.id)
    expect(r.updated.description).toBe("e2e")
    expect(r.updated.tags).toEqual(["a", "b"])
    expect(r.updated.updatedAt > r.updated.createdAt).toBe(true)
    expect(Option.isSome(r.metaEvent)).toBe(true)
    if (Option.isSome(r.metaEvent)) {
      expect(r.metaEvent.value.event._tag).toBe("ProjectMetadataChanged")
    }
    expect(r.listed.projects.find((p) => p.id === r.project.id)?.description).toBe("e2e")
    expect((r.notFound as { failure: { _tag: string } }).failure._tag).toBe("ProjectNotFound")

    const durable = Effect.gen(function* () {
      const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
      yield* awaitEndpointUp
      const listed = yield* withClient(bunAdapter, (client) => client.ProjectList({}))
      yield* Fiber.interrupt(serverFiber)
      return listed
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.provide(makeTestAppContext(dir).layer))

    const listed2 = await Effect.runPromise(durable)
    const survived = listed2.projects.find((p) => p.id === r.project.id)
    expect(survived?.description).toBe("e2e")
    expect(survived?.tags).toEqual(["a", "b"])
  })
})
