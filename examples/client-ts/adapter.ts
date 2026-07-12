import { resolveBackendCommand } from "@expand/client-ts"
import { makeBunAdapter } from "@expand/client-ts/adapters/bun"
import { fileURLToPath } from "node:url"
import { join } from "node:path"

export const adapter = (() => {
  const serverEntry = join(fileURLToPath(import.meta.url), "..", "..", "..", "apps", "server", "main.ts")
  return makeBunAdapter({
    backendCommand: () => resolveBackendCommand({ sourceEntry: serverEntry })
  })
})()
