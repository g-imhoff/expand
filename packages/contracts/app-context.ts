import { Context } from "effect"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { channel, type Channel } from "@expand/contracts/channel"

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

export const defaultDataDir = (): string => join(homedir(), NAMES.home, NAMES.channel[channel])

export const makeAppContext = (dataDir?: string): AppContextShape => ({
  channel,
  paths: derivePaths(resolve(dataDir ?? defaultDataDir()))
})

export const AppContext = Context.Reference<AppContextShape>("expand/AppContext", {
  defaultValue: () => makeAppContext(processDataDir())
})

const NAMES = {
  home: ".expand",
  channel: { dev: "expand-dev", release: "expand" },
  db: "events.db",
  endpoint: "server.json",
  logs: "logs"
} as const

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
