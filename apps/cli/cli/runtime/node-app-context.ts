import { Cause, Effect, Path } from "effect"
import { homedir } from "node:os"
import { makeAppContext } from "@expand/contracts/app-context"

export const nodeAppContext = Effect.fn("CliNodeAppContext.make")(function*(dataDir?: string) {
  const path = yield* Path.Path
  const homeDir = yield* Effect.try({ try: homedir, catch: toHostContextError })
  const cwd = yield* Effect.try({ try: () => process.cwd(), catch: toHostContextError })
  return makeAppContext(path, {
    homeDir,
    cwd,
    ...(dataDir === undefined ? {} : { dataDir })
  })
})

const toHostContextError = (cause: unknown): Cause.UnknownError =>
  new Cause.UnknownError(cause, "Unable to acquire AppContext host values")
