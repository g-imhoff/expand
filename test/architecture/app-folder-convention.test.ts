import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, FileSystem, Path } from "effect"
import { describe, expect } from "vitest"
import { runCommand } from "../support/effect-process"

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

const trackedAppSource = Effect.fn("AppFolderConvention.trackedAppSource")(function*() {
  const path = yield* Path.Path
  const root = path.resolve(".")
  const report = yield* runCommand(
    "rg",
    [
      "--files",
      "apps",
      "-g",
      "*.ts",
      "-g",
      "*.tsx",
      "-g",
      "!**/node_modules/**",
      "-g",
      "!**/test-results/**"
    ],
    { cwd: root }
  )
  expect(report.exitCode, report.stderr).toBe(0)
  return report.stdout.split(/\r?\n/).filter(Boolean)
})

const directFiles = (files: ReadonlyArray<string>, root: string): ReadonlyArray<string> =>
  files
    .filter((file) => file.startsWith(`${root}/`))
    .map((file) => file.slice(root.length + 1))
    .filter((file) => !file.includes("/"))
    .sort()

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
        "apps/cli/cli/output.ts",
        "apps/cli/cli/errors/render-errors.ts"
      ],
      [
        "apps/cli/cli/_command.ts",
        "apps/cli/cli/global-flags.ts",
        "apps/cli/cli/commands/project.ts",
        "apps/cli/cli/commands/project/_resolve.ts",
        "apps/cli/cli/app-context-layer.ts",
        "apps/cli/cli/node-app-context.ts",
        "apps/cli/cli/output/index.ts",
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

  it.live("organizes desktop modules by responsibility", () =>
    assertPaths(
      [
        "apps/desktop/src/main/index.ts",
        "apps/desktop/src/main/application/main-program.ts",
        "apps/desktop/src/main/runtime/client-runtime.ts",
        "apps/desktop/src/main/runtime/node-app-context.ts",
        "apps/desktop/src/main/runtime/supervised.ts",
        "apps/desktop/src/renderer/app/supervised.ts",
        "apps/desktop/src/renderer/components/ui/class-names.ts",
        "apps/desktop/test/ui/ui-harness.tsx"
      ],
      [
        "apps/desktop/src/main/program.ts",
        "apps/desktop/src/main/runtime.ts",
        "apps/desktop/src/main/node-app-context.ts",
        "apps/desktop/src/main/lib/supervised.ts",
        "apps/desktop/src/renderer/lib/supervised.ts",
        "apps/desktop/src/renderer/lib/utils.ts",
        "apps/desktop/test/ui/_harness.tsx"
      ]
    ).pipe(Effect.provide(NodeServices.layer)))

  it.live("uses descriptive app source names without catch-all lib folders", () =>
    Effect.gen(function*() {
      const files = yield* trackedAppSource()
      expect(files.filter((file) => file.split("/").at(-1)?.startsWith("_"))).toEqual([])
      expect(files.filter((file) => file.split("/").includes("lib"))).toEqual([])
    }).pipe(Effect.provide(NodeServices.layer)))

  it.live("keeps application and process roots limited to entrypoints", () =>
    Effect.gen(function*() {
      const files = yield* trackedAppSource()
      expect(directFiles(files, "apps/cli/cli")).toEqual(["main.ts", "output.ts"])
      expect(directFiles(files, "apps/server")).toEqual(["main.ts"])
      expect(directFiles(files, "apps/tui")).toEqual(["main.tsx"])
      expect(directFiles(files, "apps/desktop/src/main")).toEqual(["index.ts"])
      expect(directFiles(files, "apps/desktop/src/preload")).toEqual(["api.d.ts", "index.ts"])
      expect(directFiles(files, "apps/desktop/src/renderer")).toEqual(["css.d.ts", "main.tsx"])
    }).pipe(Effect.provide(NodeServices.layer)))

  it.live("documents current and optional future folder responsibilities", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const source = yield* fs.readFileString("docs/architecture/APP_STRUCTURE.md")
      for (const name of [
        "app",
        "application",
        "commands",
        "components",
        "composition",
        "contract",
        "data",
        "db",
        "errors",
        "features",
        "input",
        "ipc",
        "model",
        "output",
        "pages",
        "rpc",
        "runtime",
        "security",
        "shared",
        "shell",
        "transport",
        "adapters",
        "assets",
        "config",
        "domain",
        "hooks",
        "jobs",
        "migrations",
        "observability",
        "styles",
        "workers"
      ]) {
        expect(source).toContain(`- \`${name}\`:`)
      }
    }).pipe(Effect.provide(NodeServices.layer)))
})
