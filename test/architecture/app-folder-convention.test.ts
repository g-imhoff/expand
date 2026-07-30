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
})
