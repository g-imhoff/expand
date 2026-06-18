import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Effect, Fiber, Option, Schedule, Stream } from "effect"
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
  dir = mkdtempSync(join(tmpdir(), "yodea-del-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const awaitEndpointUp = readEndpoint.pipe(
  Effect.flatMap((o) => (Option.isSome(o) ? Effect.void : Effect.fail("pending" as const))),
  Effect.retry(Schedule.spaced("25 millis")),
  Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.fail(new Error("server never advertised an endpoint")) })
)

describe.sequential("project delete e2e", () => {
  it("deletes a project, emits ProjectDeleted, removes it from the list, and survives a restart", async () => {
    const dbPath = join(dir, "events.db")
    const first = await Effect.runPromise(
      Effect.gen(function* () {
        const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
        yield* awaitEndpointUp
        const out = yield* withClient(bunAdapter, (client) =>
          Effect.gen(function* () {
            const created = yield* client.ProjectCreate({ name: "gone", ensure: false })
            const head = yield* Effect.forkChild(
              Stream.runHead(Stream.take(Stream.filter(client.Events({}), (se) => se.event._tag === "ProjectDeleted"), 1))
            )
            yield* Effect.sleep("150 millis")
            const del = yield* client.ProjectDelete({ id: created.project.id })
            const event = yield* Fiber.join(head)
            const listed = yield* client.ProjectList({ includeArchived: true })
            return { id: created.project.id, del, event, listed }
          })
        )
        yield* Fiber.interrupt(serverFiber)
        return out
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.provide(appContextLayer(dir)))
    )
    expect(first.del).toEqual({ id: first.id, deleted: true })
    expect(Option.isSome(first.event)).toBe(true)
    expect(first.listed.projects.some((p) => p.id === first.id)).toBe(false)

    const afterRestart = await Effect.runPromise(
      Effect.gen(function* () {
        const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
        yield* awaitEndpointUp
        const listed = yield* withClient(bunAdapter, (client) => client.ProjectList({ includeArchived: true }))
        yield* Fiber.interrupt(serverFiber)
        return listed
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.provide(appContextLayer(dir)))
    )
    expect(afterRestart.projects.some((p) => p.id === first.id)).toBe(false)
  })
})
