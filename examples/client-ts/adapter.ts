import { resolveBackendCommand } from "@expand/client-ts"
import { makeBunAdapter } from "@expand/client-ts/adapters/bun"
import { fileURLToPath } from "node:url"
import { join } from "node:path"

// examples/client-ts/adapter.ts -> repo root -> apps/server/main.ts (source mode: `bun apps/server/main.ts`).
const serverEntry = join(fileURLToPath(import.meta.url), "..", "..", "..", "apps", "server", "main.ts")

/** The one bit of setup a real consumer writes once: how to locate/spawn the backend. */
export const adapter = makeBunAdapter({
  backendCommand: () => resolveBackendCommand({ sourceEntry: serverEntry })
})
