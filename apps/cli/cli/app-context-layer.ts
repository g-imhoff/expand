import { Effect, Layer, Option } from "effect"
import { AppContext } from "@expand/contracts/app-context"
import { DataDir } from "@expand/cli/global-flags"
import { nodeAppContext } from "@expand/cli/node-app-context"

export const appContextFromDataDir = Layer.effect(
  AppContext,
  Effect.flatMap(DataDir, (dataDir) => nodeAppContext(Option.getOrUndefined(dataDir)))
)
