import { createContext } from "react"
import { Layer, ManagedRuntime } from "effect"
import { BunServices } from "@effect/platform-bun"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { ProjectStore } from "@yodea/client-core"
import { ProjectStoreLayer } from "@yodea/client-core/project-store"
import { makeBunAdapter } from "@yodea/client-core/adapters/bun"

export type YodeaRuntime = ManagedRuntime.ManagedRuntime<ProjectStore, never>

// Provided via React context so tests can inject a fake-store runtime.
export const RuntimeContext = createContext<YodeaRuntime | null>(null)

// Resolve how to launch the backend INDEPENDENTLY of Bun.main. For the TUI,
// Bun.main is this frontend's entry (apps/tui/main.tsx), so the default
// Bun.main-derived command would spawn a second TUI and never boot a backend.
// Dev: resolve the real CLI entry relative to THIS module
// (apps/tui/runtime.ts -> ../cli/cli/main.ts -> apps/cli/cli/main.ts) and run it
// with the bun executable. Packaged/prod: override via YODEA_BACKEND_CMD (a JSON
// array, e.g. ["/path/to/yodea","server"]).
const resolveBackendCommand = (): ReadonlyArray<string> => {
  const override = process.env.YODEA_BACKEND_CMD
  if (override) {
    const parsed = JSON.parse(override) as ReadonlyArray<string>
    if (!Array.isArray(parsed) || parsed.some((s) => typeof s !== "string")) {
      throw new Error("YODEA_BACKEND_CMD must be a JSON array of strings")
    }
    return parsed
  }
  const here = fileURLToPath(import.meta.url) // .../apps/tui/runtime.ts
  const backendEntry = join(here, "..", "..", "cli", "cli", "main.ts") // .../apps/cli/cli/main.ts
  return [process.execPath, backendEntry, "server"]
}

export const makeProductionRuntime = (): YodeaRuntime =>
  ManagedRuntime.make(
    ProjectStoreLayer(makeBunAdapter({ backendCommand: resolveBackendCommand() })).pipe(
      Layer.provide(BunServices.layer)
    )
  )
