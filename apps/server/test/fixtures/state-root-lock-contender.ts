import { Effect, FileSystem, Schedule, Schema, Stdio } from "effect"
import { ProcessControl } from "@expand/contracts/process-control"
import { ProcessServices } from "@expand/server/node-process-control"
import {
  acquireStateRootLock,
  releaseStateRootLock
} from "@expand/server/state-root-lock"

const ContenderResult = Schema.fromJsonString(Schema.Union([
  Schema.Struct({
    status: Schema.Literal("acquired"),
    pid: Schema.Number,
    token: Schema.String
  }),
  Schema.Struct({
    status: Schema.Literal("rejected"),
    reason: Schema.String
  })
]))

const waitForFile = Effect.fn("StateRootLockTest.waitForFile")(function*(path: string) {
  const fs = yield* FileSystem.FileSystem
  yield* fs.exists(path).pipe(
    Effect.filterOrFail((exists) => exists, () => "pending" as const),
    Effect.retry(Schedule.spaced("1 millis")),
    Effect.asVoid
  )
})

const lease = await Effect.runPromise(
  Effect.gen(function*() {
    const stdio = yield* Stdio.Stdio
    const processControl = yield* ProcessControl
    const [root, readyPath, startPath, releasePath, resultPath] = yield* stdio.args
    if (
      root === undefined ||
      readyPath === undefined ||
      startPath === undefined ||
      releasePath === undefined ||
      resultPath === undefined
    ) {
      return yield* Effect.fail("missing state-root contender argument" as const)
    }

    const fs = yield* FileSystem.FileSystem
    yield* fs.writeFileString(readyPath, String(processControl.currentPid))
    yield* waitForFile(startPath)
    const result = yield* Effect.result(acquireStateRootLock(root))
    const encoded = yield* Schema.encodeEffect(ContenderResult)(result._tag === "Success"
      ? { status: "acquired" as const, pid: result.success.pid, token: result.success.token }
      : {
          status: "rejected" as const,
          reason: result.failure instanceof Error ? result.failure.message : String(result.failure)
        })
    const temporaryPath = `${resultPath}.${processControl.currentPid}.tmp`
    yield* fs.writeFileString(temporaryPath, encoded)
    yield* fs.rename(temporaryPath, resultPath)
    if (result._tag === "Success") {
      yield* waitForFile(releasePath)
      yield* releaseStateRootLock(result.success)
      return result.success
    }
    return undefined
  }).pipe(
    Effect.provide(ProcessServices.layer),
    Effect.orDie
  )
)

void lease
