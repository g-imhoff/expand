import { NodeRuntime } from "@effect/platform-node"
import { Effect, FileSystem, Schedule, Schema, Stdio } from "effect"
import { acquireSpawnLock, releaseSpawnLock } from "../../spawn-lock"
import { ProcessServices } from "../../adapters/node-process-control"

const ContenderResult = Schema.fromJsonString(Schema.Union([
  Schema.Struct({ status: Schema.Literal("contended") }),
  Schema.Struct({
    status: Schema.Literal("acquired"),
    pid: Schema.Number,
    token: Schema.String
  })
]))

const waitForFile = Effect.fn("SpawnLockTest.waitForFile")(function*(path: string) {
  const fs = yield* FileSystem.FileSystem
  yield* fs.exists(path).pipe(
    Effect.filterOrFail((exists) => exists, () => "pending" as const),
    Effect.retry(Schedule.spaced("1 millis")),
    Effect.asVoid
  )
})

NodeRuntime.runMain(
  Effect.gen(function*() {
    const stdio = yield* Stdio.Stdio
    const [lockPath, readyPath, startPath, releasePath, resultPath] = yield* stdio.args
    if (
      lockPath === undefined ||
      readyPath === undefined ||
      startPath === undefined ||
      releasePath === undefined ||
      resultPath === undefined
    ) {
      return yield* Effect.fail("missing spawn-lock contender argument" as const)
    }

    const fs = yield* FileSystem.FileSystem
    yield* fs.writeFileString(readyPath, "ready")
    yield* waitForFile(startPath)
    const acquired = yield* acquireSpawnLock(lockPath)
    const encoded = yield* Schema.encodeEffect(ContenderResult)(acquired === undefined
      ? { status: "contended" as const }
      : { status: "acquired" as const, pid: acquired.pid, token: acquired.token })
    const temporaryPath = `${resultPath}.tmp`
    yield* fs.writeFileString(temporaryPath, encoded)
    yield* fs.rename(temporaryPath, resultPath)
    if (acquired !== undefined) {
      yield* waitForFile(releasePath)
      yield* releaseSpawnLock(acquired)
    }
  }).pipe(
    Effect.provide(ProcessServices.layer),
    Effect.orDie
  )
)
