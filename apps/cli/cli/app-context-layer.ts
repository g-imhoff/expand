import { Effect, Layer, Option } from "effect"
import { AppContext, makeAppContext } from "@expand/contracts/app-context"
import { DataDir } from "@expand/cli/global-flags"

export const appContextFromDataDir = Layer.effect(
  AppContext,
  Effect.map(DataDir, (dataDir) => makeAppContext(Option.getOrUndefined(dataDir)))
)
