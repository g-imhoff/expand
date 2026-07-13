import { resolveBackendCommand } from "@expand/client-ts"
import { makeNodeAdapter } from "@expand/client-ts/adapters/node"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { nodeAppContextLayer } from "./node-app-context"

export const adapter = (() => {
  const serverEntry = join(fileURLToPath(import.meta.url), "..", "..", "..", "apps", "server", "main.ts")
  return makeNodeAdapter({
    backendCommand: () =>
      resolveBackendCommand({
        execPath: process.execPath,
        runtimeArgs: ["--import", "tsx"],
        sourceEntry: serverEntry,
        binaryArgs: [process.execPath, join(dirname(fileURLToPath(import.meta.url)), "expand-server")]
      })
  })
})()

Object.assign(adapter, { nodeAppContextLayer })
