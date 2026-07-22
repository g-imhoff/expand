import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, Exit, Queue, Fiber, FileSystem, Layer, Option, Path, Schedule, Scope, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import * as Socket from "effect/unstable/socket/Socket"
import { describe, expect } from "vitest"
import { readEndpoint } from "@expand/client-ts"
import { ProcessServices } from "@expand/client-ts/adapters/node"
import { AppContext, makeAppContext } from "@expand/contracts/app-context"
import { ProcessControl } from "@expand/contracts/process-control"
import { makeTempDirectoryScoped } from "../../../../test/support/effect-files"

const probeTcp = (host: string, port: number) =>
  Effect.scoped(Effect.gen(function*() {
    const socket = yield* NodeSocket.makeNet({ host, port, openTimeout: "1 second" })
    const opened = yield* Queue.unbounded<void>()
    const run = yield* socket.runRaw(() => undefined, {
      onOpen: Queue.offer(opened, undefined)
    }).pipe(Effect.forkScoped)
    return yield* Effect.race(
      Queue.take(opened).pipe(Effect.as(true)),
      Fiber.join(run).pipe(Effect.as(false), Effect.catchCause(() => Effect.succeed(false)))
    ).pipe(Effect.timeoutOrElse({ duration: "1 second", orElse: () => Effect.succeed(false) }))
  }))

describe("test harness", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2)
  })

  it.live("finalizes the database, server, listener, socket, child process, and temporary directory on failure", () =>
    Effect.scoped(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const processControl = yield* ProcessControl
      const parentScope = yield* Scope.Scope
      const fixtureScope = yield* Scope.fork(parentScope)
      const fixture = yield* Effect.gen(function*() {
        const directory = yield* makeTempDirectoryScoped("expand-server-harness-")
        const handle = yield* ChildProcess.make(
          "node",
          ["--import", "tsx", "apps/server/main.ts", "--data-dir", directory],
          { stdin: "ignore", stdout: "pipe", stderr: "pipe" }
        )
        yield* Effect.forkScoped(Stream.runDrain(handle.stdout))
        yield* Effect.forkScoped(Stream.runDrain(handle.stderr))
        const context = makeAppContext(path, { homeDir: directory, cwd: directory, dataDir: directory })
        const endpoint = yield* readEndpoint.pipe(
          Effect.flatMap((option) => Option.isSome(option) ? Effect.succeed(option.value) : Effect.fail("pending" as const)),
          Effect.retry(Schedule.spaced("25 millis")),
          Effect.timeout("5 seconds"),
          Effect.provide(Layer.succeed(AppContext, context))
        )
        const opened = yield* Queue.unbounded<void>()
        const socket = yield* Socket.makeWebSocket(`${endpoint.url}?token=${encodeURIComponent(endpoint.token)}`).pipe(
          Effect.provide(NodeSocket.layerWebSocketConstructorWS)
        )
        const socketFiber = yield* socket.runRaw(() => undefined, {
          onOpen: Queue.offer(opened, undefined)
        }).pipe(Effect.forkScoped)
        yield* Queue.take(opened).pipe(Effect.timeout("5 seconds"))
        return { directory, endpoint, handle, socketFiber }
      }).pipe(Scope.provide(fixtureScope))

      const pid = Number(fixture.handle.pid)
      expect(yield* processControl.probe(pid)).toBe("alive")
      expect(yield* probeTcp("127.0.0.1", Number(new URL(fixture.endpoint.url).port))).toBe(true)
      yield* Scope.close(fixtureScope, Exit.fail("forced assertion failure"))
      yield* fixture.handle.exitCode.pipe(Effect.timeout("5 seconds"))
      expect(yield* processControl.probe(pid)).toBe("dead")
      expect(yield* probeTcp("127.0.0.1", Number(new URL(fixture.endpoint.url).port))).toBe(false)
      expect(fixture.socketFiber.pollUnsafe()?._tag).toBe("Failure")
      expect(yield* fs.exists(path.join(fixture.directory, "events.db"))).toBe(false)
      expect(yield* fs.exists(fixture.directory)).toBe(false)
    })).pipe(Effect.provide(ProcessServices.layer), Effect.provide(NodeServices.layer)))
})
