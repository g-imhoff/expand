import { Context } from "effect"
import { channel, type Channel } from "@expand/contracts/channel"

export interface AppContextPathOps {
  readonly join: (...paths: ReadonlyArray<string>) => string
  readonly resolve: (...paths: ReadonlyArray<string>) => string
}

export interface AppContextInput {
  readonly homeDir: string
  readonly cwd: string
  readonly dataDir?: string
  readonly channel?: Channel
}

export interface AppPath {
  readonly dataDir: string
  readonly dbPath: string
  readonly endpointFile: string
  readonly logDir: string
  readonly spawnLockFile: string
}

export interface AppContextShape {
  readonly channel: Channel
  readonly paths: AppPath
}

export class AppContext extends Context.Service<AppContext, AppContextShape>()(
  "expand/AppContext"
) {
  static make(path: AppContextPathOps, input: AppContextInput): AppContextShape {
    return makeAppContext(path, input)
  }
}

export const defaultDataDir = (
  path: AppContextPathOps,
  homeDir: string,
  selectedChannel: Channel = channel
): string => path.join(homeDir, NAMES.home, NAMES.channel[selectedChannel])

export const makeAppContext = (
  path: AppContextPathOps,
  input: AppContextInput
): AppContextShape => {
  const selectedChannel = input.channel ?? channel
  const fallback = path.resolve(input.cwd, defaultDataDir(path, input.homeDir, selectedChannel))
  const base = path.resolve(input.cwd, input.dataDir ?? fallback)
  return {
    channel: selectedChannel,
    paths: derivePaths(path, input.homeDir, base, fallback, selectedChannel)
  }
}

export const dataDirFromArgs = (args: ReadonlyArray<string>): string | undefined => {
  const index = args.indexOf("--data-dir")
  return index !== -1 && index + 1 < args.length ? args[index + 1] : undefined
}

const NAMES = {
  home: ".expand",
  channel: { dev: "expand-dev", release: "expand" },
  db: "events.db",
  endpoint: "server.json",
  logs: "logs",
  coordination: ".expand-locks",
  spawnLock: { dev: "expand-dev.spawn.lock", release: "expand.spawn.lock" }
} as const

const derivePaths = (
  path: AppContextPathOps,
  homeDir: string,
  base: string,
  fallback: string,
  selectedChannel: Channel
): AppPath => ({
  dataDir: base,
  dbPath: path.join(base, NAMES.db),
  endpointFile: path.join(base, NAMES.endpoint),
  logDir: path.join(base, NAMES.logs),
  spawnLockFile: base === fallback
    ? path.join(homeDir, NAMES.coordination, NAMES.spawnLock[selectedChannel])
    : path.join(base, `${NAMES.endpoint}.lock`)
})
