import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, FileSystem } from "effect"
import { describe, expect } from "vitest"

const assertPaths = Effect.fn("AppFolderConvention.assertPaths")(function*(
  expected: ReadonlyArray<string>,
  retired: ReadonlyArray<string>
) {
  const fs = yield* FileSystem.FileSystem
  for (const file of expected) {
    expect(yield* fs.exists(file), `expected ${file} to exist`).toBe(true)
  }
  for (const file of retired) {
    expect(yield* fs.exists(file), `expected ${file} to be retired`).toBe(false)
  }
})

describe("app responsibility folder convention", () => {
  it.live("organizes CLI modules by responsibility", () =>
    assertPaths(
      [
        "apps/cli/cli/main.ts",
        "apps/cli/cli/commands/define-command.ts",
        "apps/cli/cli/commands/global-flags.ts",
        "apps/cli/cli/commands/project/index.ts",
        "apps/cli/cli/commands/project/resolve-project-target.ts",
        "apps/cli/cli/runtime/app-context-layer.ts",
        "apps/cli/cli/runtime/node-app-context.ts",
        "apps/cli/cli/output/index.ts",
        "apps/cli/cli/errors/render-errors.ts"
      ],
      [
        "apps/cli/cli/_command.ts",
        "apps/cli/cli/global-flags.ts",
        "apps/cli/cli/commands/project.ts",
        "apps/cli/cli/commands/project/_resolve.ts",
        "apps/cli/cli/app-context-layer.ts",
        "apps/cli/cli/node-app-context.ts",
        "apps/cli/cli/output.ts",
        "apps/cli/cli/run.ts"
      ]
    ).pipe(Effect.provide(NodeServices.layer)))

  it.live("organizes server modules by responsibility", () =>
    assertPaths(
      [
        "apps/server/main.ts",
        "apps/server/application/ids.ts",
        "apps/server/rpc/handlers.ts",
        "apps/server/runtime/connection-tracker.ts",
        "apps/server/runtime/endpoint-file.ts",
        "apps/server/runtime/node-app-context.ts",
        "apps/server/runtime/node-process-control.ts",
        "apps/server/runtime/server-config.ts",
        "apps/server/runtime/state-root-lock.ts",
        "apps/server/transport/http-server.ts"
      ],
      [
        "apps/server/lib/ids.ts",
        "apps/server/rpc-handlers.ts",
        "apps/server/connection-tracker.ts",
        "apps/server/endpoint-file.ts",
        "apps/server/node-app-context.ts",
        "apps/server/node-process-control.ts",
        "apps/server/server-config.ts",
        "apps/server/state-root-lock.ts",
        "apps/server/http.ts"
      ]
    ).pipe(Effect.provide(NodeServices.layer)))

  it.live("organizes TUI modules by responsibility", () =>
    assertPaths(
      [
        "apps/tui/main.tsx",
        "apps/tui/runtime/tui-runtime.ts",
        "apps/tui/runtime/effect-runner.ts",
        "apps/tui/runtime/node-app-context.ts",
        "apps/tui/features/projects/use-projects.ts",
        "apps/tui/test/ui/runtime-harness.ts"
      ],
      [
        "apps/tui/runtime.ts",
        "apps/tui/effect-runner.ts",
        "apps/tui/node-app-context.ts",
        "apps/tui/use-projects.ts",
        "apps/tui/test/ui/_runtime-harness.ts"
      ]
    ).pipe(Effect.provide(NodeServices.layer)))
})
