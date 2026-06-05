import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { homedir } from "node:os"
import { join } from "node:path"
import { runServer } from "@yodea/composition/app"

const dbPath = Effect.sync(() => process.env.YODEA_DB ?? join(homedir(), ".yodea", "events.db"))

const program = Effect.gen(function* () {
  const path = yield* dbPath
  yield* runServer({ dbPath: path }).pipe(
    Effect.ensuring(Effect.sync(() => process.exit(0)))
  )
})

program.pipe(
  Effect.provide(BunServices.layer),
  BunRuntime.runMain
)
