import { existsSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

// Fitness test for PR review #11: all backend code is owned by apps/server.
// apps/cli keeps ONLY its CLI presentation tree (apps/cli/cli/**).

const SERVER_FILES = [
  "apps/server/composition/app.ts",
  "apps/server/db/event-store.ts",
  "apps/server/db/replay-feed.ts",
  "apps/server/application/projects/project-event-store.ts",
  "apps/server/application/event-bus.ts",
  "apps/server/application/projections.ts",
  "apps/server/application/projects/use-cases.ts",
  "apps/server/application/server/use-cases.ts",
  "apps/server/http.ts",
  "apps/server/connection-tracker.ts",
  "apps/server/endpoint-file.ts",
  "apps/server/state-root-lock.ts",
  "apps/server/rpc-handlers.ts",
  "apps/server/lib/ids.ts"
] as const

const CLI_FORBIDDEN_DIRS = [
  "apps/cli/application",
  "apps/cli/composition",
  "apps/cli/db",
  "apps/cli/domain",
  "apps/cli/server",
  "apps/cli/lib"
] as const

describe("backend ownership (#11)", () => {
  it("hosts every backend module under apps/server", () => {
    for (const file of SERVER_FILES) {
      expect(existsSync(file), `expected ${file} to exist`).toBe(true)
    }
  })

  it("leaves apps/cli with no backend directories — only the CLI presentation tree", () => {
    for (const dir of CLI_FORBIDDEN_DIRS) {
      expect(existsSync(dir), `expected ${dir} to be gone from apps/cli`).toBe(false)
    }
    // The CLI presentation tree stays put.
    expect(existsSync("apps/cli/cli/main.ts")).toBe(true)
  })

  it("defines backend ownership per state root", () => {
    const model = readFileSync("docs/architecture/expand.c4", "utf8")

    expect(model).toContain("One live backend per selected state root")
    expect(model).toContain("backend.lock")
  })
})
