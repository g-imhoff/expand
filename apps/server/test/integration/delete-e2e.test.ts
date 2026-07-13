import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Effect, Fiber, Option, Schedule, Stream, Layer } from "effect"
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
  backendCommand: [process.execPath, "--import", "tsx", join(process.cwd(), "apps/server/main.ts")]
})

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "expand-del-"))
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
        const out = yield* withClient(nodeAdapter, (client) =>
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
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.provide(Layer.succeed(AppContext, makeTestAppContext(dir))))
    )
    expect(first.del).toEqual({ id: first.id, deleted: true })
    expect(Option.isSome(first.event)).toBe(true)
    expect(first.listed.projects.some((p) => p.id === first.id)).toBe(false)

    const afterRestart = await Effect.runPromise(
      Effect.gen(function* () {
        const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
        yield* awaitEndpointUp
        const listed = yield* withClient(nodeAdapter, (client) => client.ProjectList({ includeArchived: true }))
        yield* Fiber.interrupt(serverFiber)
        return listed
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.provide(Layer.succeed(AppContext, makeTestAppContext(dir))))
    )
    expect(afterRestart.projects.some((p) => p.id === first.id)).toBe(false)
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
