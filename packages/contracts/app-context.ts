import { Context } from "effect"
import { homedir } from "node:os"
import { join } from "node:path"
import { channel, type Channel } from "@yodea/contracts/channel"

export interface AppPath {
  readonly dataDir: string
  readonly dbPath: string
  readonly endpointFile: string
  readonly logDir: string
}

export interface AppContextShape {
  readonly channel: Channel
  readonly paths: AppPath
}

export const AppContext = Context.Reference<AppContextShape>("yodea/AppContext", {
  defaultValue: () => deriveContext(processDataDir())
})

const NAMES = {
  home: ".yodea",
  channel: { dev: "yodea-dev", release: "yodea" },
  db: "events.db",
  endpoint: "server.json",
  logs: "logs"
} as const

const channelBase = (): string => join(homedir(), NAMES.home, NAMES.channel[channel])

const derivePaths = (base: string): AppPath => ({
  dataDir: base,
  dbPath: join(base, NAMES.db),
  endpointFile: join(base, NAMES.endpoint),
  logDir: join(base, NAMES.logs)
})

const processDataDir = (): string | undefined => {
  const i = process.argv.indexOf("--data-dir")
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined
}

const deriveContext = (baseDir?: string): AppContextShape => ({
  channel,
  paths: derivePaths(baseDir ?? channelBase())
})
