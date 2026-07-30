import { Effect, Layer, Option } from "effect"
import { AppContext } from "@expand/contracts/app-context"
import { DataDir } from "@expand/cli/commands/global-flags"
import { nodeAppContext } from "@expand/cli/runtime/node-app-context"

export const appContextFromDataDir = Layer.effect(
  AppContext,
  Effect.flatMap(DataDir, (dataDir) => nodeAppContext(Option.getOrUndefined(dataDir)))
)
