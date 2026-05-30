import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Effect, Fiber, FileSystem, Option, Schedule, Stream } from "effect"
import { BunServices } from "@effect/platform-bun"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runServer } from "@yodea/composition/app"
import { withClient } from "@yodea/cli/rpc-client"
import { readEndpoint } from "@yodea/cli/discovery"
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
      // No fixed port: the server binds an ephemeral OS port and advertises the
      // real URL in the discovery file; the client discovers it from there.
      const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))

      yield* awaitEndpointUp
      const upDuring = yield* fs.exists(endpointFilePath())

      const outcome = yield* withClient((client) =>
        Effect.gen(function* () {
          const health = yield* client.Health()
          const created = yield* client.ProjectCreate({ name: "E2E" })
          const listed = yield* client.ProjectList()
          return { health, created, listed }
        })
      )

      // Last client gone -> the server must shut itself down (I-4).
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
    expect(r.upDuring).toBe(true) // I-3: advertised while alive
    expect(r.outcome.health).toBe("ok")
    expect(r.outcome.created.name).toBe("E2E")
    expect(r.outcome.listed).toEqual([r.outcome.created]) // event -> projection over the wire
    expect(r.upAfter).toBe(false) // I-3/I-4: endpoint removed on zero-connection shutdown
  })

  it("delivers live domain events over the Events stream", async () => {
    const program = Effect.gen(function* () {
      const dbPath = join(dir, "events.db")
      const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
      yield* awaitEndpointUp

      const observed = yield* withClient((client) =>
        Effect.gen(function* () {
          // Start listening, give the subscription time to attach, then create.
          const head = yield* Effect.forkChild(Stream.runHead(Stream.take(client.Events(), 1)))
          yield* Effect.sleep("150 millis")
          yield* client.ProjectCreate({ name: "live" })
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
      expect(observed.value.name).toBe("live")
    }
  })
})
