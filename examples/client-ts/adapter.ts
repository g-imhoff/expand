import { resolveBackendCommand } from "@expand/client-ts"
import { makeNodeAdapter } from "@expand/client-ts/adapters/node"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { Effect } from "effect"
export { clientLayer } from "./node-app-context"

export const adapter = makeNodeAdapter({
  backendCommand: Effect.suspend(() => {
    const serverEntry = join(fileURLToPath(import.meta.url), "..", "..", "..", "apps", "server", "main.ts")
    return resolveBackendCommand({
      execPath: process.execPath,
      runtimeArgs: ["--import", "tsx"],
      sourceEntry: serverEntry,
      binaryArgs: [process.execPath, join(dirname(fileURLToPath(import.meta.url)), "expand-server")]
    })
  })
})
