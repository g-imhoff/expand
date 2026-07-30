import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, FileSystem } from "effect"
import { describe, expect } from "vitest"

const SERVER_FILES = [
  "apps/server/composition/app.ts",
  "apps/server/db/event-store.ts",
  "apps/server/db/replay-feed.ts",
  "apps/server/application/projects/project-event-store.ts",
  "apps/server/application/event-bus.ts",
  "apps/server/application/projections.ts",
  "apps/server/application/projects/use-cases.ts",
  "apps/server/application/server/use-cases.ts",
  "apps/server/transport/http-server.ts",
  "apps/server/runtime/connection-tracker.ts",
  "apps/server/runtime/endpoint-file.ts",
  "apps/server/runtime/state-root-lock.ts",
  "apps/server/rpc/handlers.ts",
  "apps/server/application/ids.ts"
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
  it.live("hosts every backend module under apps/server", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      for (const file of SERVER_FILES) {
        expect(yield* fs.exists(file), `expected ${file} to exist`).toBe(true)
      }
    }).pipe(Effect.provide(NodeServices.layer)))

  it.live("leaves apps/cli with no backend directories — only the CLI presentation tree", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      for (const dir of CLI_FORBIDDEN_DIRS) {
        expect(yield* fs.exists(dir), `expected ${dir} to be gone from apps/cli`).toBe(false)
      }
      expect(yield* fs.exists("apps/cli/cli/main.ts")).toBe(true)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.live("defines backend ownership per state root", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const model = yield* fs.readFileString("docs/architecture/expand.c4")
      expect(model).toContain("One live backend per selected state root")
      expect(model).toContain("backend.lock")
    }).pipe(Effect.provide(NodeServices.layer)))
})
