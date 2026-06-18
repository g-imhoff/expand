import { Context, Effect, Layer } from "effect"
import { homedir } from "node:os"
import { join } from "node:path"
import { channel } from "@yodea/contracts/channel"

export interface PathsShape {
  readonly dataDir: string      // <base>
  readonly dbPath: string       // <base>/events.db
  readonly endpointFile: string // <base>/server.json
  readonly logDir: string       // <base>/logs
}

// OS data home — honors $XDG_DATA_HOME / platform conventions. Reads ONLY OS env
// ($XDG_DATA_HOME / $HOME / %LOCALAPPDATA%), never any YODEA_* variable.
const osDataHome = (): string => {
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support")
  if (process.platform === "win32") return process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")
  return process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")
}

const channelBase = (): string => join(osDataHome(), channel === "dev" ? "yodea-dev" : "yodea")

const derive = (base: string): PathsShape => ({
  dataDir: base,
  dbPath: join(base, "events.db"),
  endpointFile: join(base, "server.json"),
  logDir: join(base, "logs")
})

// Pure resolver. baseDir = parsed --data-dir (spawned child / test) ?? channel base.
export const resolvePaths = (baseDir?: string): PathsShape => derive(baseDir ?? channelBase())

export class Paths extends Context.Service<Paths, PathsShape>()("yodea/Paths", {
  make: Effect.sync(() => resolvePaths()) // default = channel-derived base
}) {}

export const pathsLayer = (baseDir?: string): Layer.Layer<Paths> =>
  Layer.succeed(Paths, resolvePaths(baseDir))
