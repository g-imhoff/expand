import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Cause, Effect, Exit, FileSystem, Path } from "effect"
import { join } from "node:path"
import { yodeaHomeDir } from "@yodea/contracts/endpoint"
import { runServer } from "@yodea/server/composition/app"

const dbPath = (): string => process.env.YODEA_DB ?? join(yodeaHomeDir(), "events.db")

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const db = dbPath()
  yield* fs.makeDirectory(path.dirname(db), { recursive: true })
  yield* runServer({ dbPath: db })
})

BunRuntime.runMain(
  program.pipe(
    Effect.provide(BunServices.layer),
    Effect.tap(() => Effect.sync(() => process.exit(0)))
  ),
  {
    teardown: (exit, onExit) =>
      onExit(Exit.isSuccess(exit) || (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) ? 0 : 1)
  }
)
