import { Command } from "effect/unstable/cli"
import { homedir } from "node:os"
import { join } from "node:path"
import { runServer } from "@yodea/composition/app" // I-1 permitted exception (this file only)

const dbPath = () =>
  process.env.YODEA_DB ??
  join(process.env.YODEA_HOME ?? join(homedir(), ".yodea"), "events.db")

export const serverCommand = Command.make("server", {}, () =>
  runServer({ dbPath: dbPath(), port: 51789 })
)
