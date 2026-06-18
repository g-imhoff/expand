import { Context, Effect, Layer } from "effect"
import { homedir } from "node:os"
import { join } from "node:path"
import { channel, type Channel } from "@yodea/contracts/channel"

export interface PathsShape {
  readonly dataDir: string      // <base>
  readonly dbPath: string       // <base>/events.db
  readonly endpointFile: string // <base>/server.json
  readonly logDir: string       // <base>/logs
}

// The application's runtime context: which build it is, and where its files live.
// Paths are one facet — the service is the place future app-level context grows.
export interface AppContextShape {
  readonly channel: Channel
  readonly paths: PathsShape
}

// OS data home — honors $XDG_DATA_HOME / platform conventions. Reads ONLY OS env
// ($XDG_DATA_HOME / $HOME / %LOCALAPPDATA%), never any YODEA_* variable.
const osDataHome = (): string => {
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support")
  if (process.platform === "win32") return process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")
  return process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")
}

const channelBase = (): string => join(osDataHome(), channel === "dev" ? "yodea-dev" : "yodea")

const derivePaths = (base: string): PathsShape => ({
  dataDir: base,
  dbPath: join(base, "events.db"),
  endpointFile: join(base, "server.json"),
  logDir: join(base, "logs")
})

// Pure resolver. baseDir = parsed --data-dir (spawned child / test) ?? channel base.
export const resolveAppContext = (baseDir?: string): AppContextShape => ({
  channel,
  paths: derivePaths(baseDir ?? channelBase())
})

export class AppContext extends Context.Service<AppContext, AppContextShape>()("yodea/AppContext", {
  make: Effect.sync(() => resolveAppContext()) // default = channel-derived base
}) {}

export const appContextLayer = (baseDir?: string): Layer.Layer<AppContext> =>
  Layer.succeed(AppContext, resolveAppContext(baseDir))
