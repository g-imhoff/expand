// CRITICAL : This is an should be used for testing purpose only and nothing else
// It should never be used for production code

import { Layer } from "effect"
import { join } from "node:path"
import { channel } from "@expand/contracts/channel"
import { AppContext, type AppContextShape, type AppPath } from "@expand/contracts/app-context"

export interface TestAppContext {
  readonly layer: Layer.Layer<never>
  readonly ctx: AppContextShape
  readonly paths: AppPath
}

export const makeTestAppContext = (dir: string): TestAppContext => {
  const ctx: AppContextShape = {
    channel,
    paths: {
      dataDir: dir,
      dbPath: join(dir, "events.db"),
      endpointFile: join(dir, "server.json"),
      logDir: join(dir, "logs")
    }
  }
  return { layer: Layer.succeed(AppContext, ctx), ctx, paths: ctx.paths }
}
