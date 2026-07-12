import { Context } from "effect"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { channel, type Channel } from "@expand/contracts/channel"

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

export const defaultDataDir = (selectedChannel: Channel = channel): string =>
  join(homedir(), NAMES.home, NAMES.channel[selectedChannel])

export const makeAppContext = (
  dataDir?: string,
  selectedChannel: Channel = channel
): AppContextShape => {
  const defaultDir = resolve(defaultDataDir(selectedChannel))
  const base = resolve(dataDir ?? defaultDir)
  return {
    channel: selectedChannel,
    paths: derivePaths(base, defaultDir, selectedChannel)
  }
}

export const AppContext = Context.Reference<AppContextShape>("expand/AppContext", {
  defaultValue: () => makeAppContext(processDataDir())
})

const NAMES = {
  home: ".expand",
  channel: { dev: "expand-dev", release: "expand" },
  db: "events.db",
  endpoint: "server.json",
  logs: "logs",
  coordination: ".expand-locks",
  spawnLock: { dev: "expand-dev.spawn.lock", release: "expand.spawn.lock" }
} as const

const derivePaths = (base: string, defaultDir: string, selectedChannel: Channel): AppPath => ({
  dataDir: base,
  dbPath: join(base, NAMES.db),
  endpointFile: join(base, NAMES.endpoint),
  logDir: join(base, NAMES.logs),
  spawnLockFile: base === defaultDir
    ? join(homedir(), NAMES.coordination, NAMES.spawnLock[selectedChannel])
    : join(base, `${NAMES.endpoint}.lock`)
})

const processDataDir = (): string | undefined => {
  const i = process.argv.indexOf("--data-dir")
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined
}
