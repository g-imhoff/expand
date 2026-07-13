import { Cause, Effect, Layer, Path, Stdio } from "effect"
import { homedir } from "node:os"
import { AppContext, dataDirFromArgs, makeAppContext } from "@expand/contracts/app-context"

export const nodeAppContext = Effect.fn("DesktopNodeAppContext.make")(function*(dataDir?: string) {
  const path = yield* Path.Path
  const homeDir = yield* Effect.try({ try: homedir, catch: toHostContextError })
  const cwd = yield* Effect.try({ try: () => process.cwd(), catch: toHostContextError })
  return makeAppContext(path, {
    homeDir,
    cwd,
    ...(dataDir === undefined ? {} : { dataDir })
  })
})

export const nodeAppContextFromArgs = Effect.fn("DesktopNodeAppContext.fromArgs")(function*() {
  const stdio = yield* Stdio.Stdio
  const args = yield* stdio.args
  return yield* nodeAppContext(dataDirFromArgs(args))
})

export const nodeAppContextLayer = Layer.effect(AppContext, nodeAppContextFromArgs())

const toHostContextError = (cause: unknown): Cause.UnknownError =>
  new Cause.UnknownError(cause, "Unable to acquire AppContext host values")
