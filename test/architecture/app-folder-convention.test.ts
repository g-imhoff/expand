import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, FileSystem, Path } from "effect"
import { describe, expect } from "vitest"
import { makeTempDirectoryScoped, writeFixture } from "../support/effect-files"
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

const appSourceManifest = Effect.fn("AppFolderConvention.appSourceManifest")(function*(root: string) {
  const report = yield* runCommand(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "apps/**/*.ts", "apps/**/*.tsx"],
    { cwd: root }
  )
  expect(report.exitCode, report.stderr).toBe(0)
  return report.stdout.split("\0").filter(Boolean).sort()
})

const gitFixture = Effect.fn("AppFolderConvention.gitFixture")(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* makeTempDirectoryScoped("expand-app-folders-")
  const files = {
    ".gitignore": "apps/desktop/src/main/tracked-ignored.ts\n",
    "apps/desktop/src/main/index.ts": "",
    "apps/desktop/src/main/tracked-ignored.ts": "",
    "apps/desktop/src/preload/index.ts": "",
    "apps/desktop/src/renderer/main.tsx": "",
    "apps/desktop/src/shared/ipc/channels.ts": "",
    "apps/desktop/src/worker/untracked.ts": ""
  }
  for (const [file, source] of Object.entries(files)) {
    yield* fs.makeDirectory(path.dirname(path.join(root, file)), { recursive: true })
    yield* writeFixture(root, file, source)
  }
  for (const args of [
    ["init", "-q"],
    ["add", ".gitignore", "apps/desktop/src/main/index.ts", "apps/desktop/src/preload/index.ts", "apps/desktop/src/renderer/main.tsx", "apps/desktop/src/shared/ipc/channels.ts"],
    ["add", "-f", "apps/desktop/src/main/tracked-ignored.ts"]
  ]) {
    const report = yield* runCommand("git", args, { cwd: root })
    expect(report.exitCode, report.stderr).toBe(0)
  }
  return root
})

const directFiles = (files: ReadonlyArray<string>, root: string): ReadonlyArray<string> =>
  files
    .filter((file) => file.startsWith(`${root}/`))
    .map((file) => file.slice(root.length + 1))
    .filter((file) => !file.includes("/"))
    .sort()

const assertDesktopProcessRoots = (files: ReadonlyArray<string>): void => {
  const roots = [
    ...new Set(
      files
        .filter((file) => file.startsWith("apps/desktop/src/"))
        .map((file) => file.slice("apps/desktop/src/".length).split("/")[0])
    )
  ].sort()
  expect(roots).toEqual(["main", "preload", "renderer", "shared"])
}

describe("app responsibility folder convention", () => {
  it.live("includes tracked ignored and non-ignored untracked app sources", () =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* gitFixture()
      expect(yield* appSourceManifest(root)).toEqual([
        "apps/desktop/src/main/index.ts",
        "apps/desktop/src/main/tracked-ignored.ts",
        "apps/desktop/src/preload/index.ts",
        "apps/desktop/src/renderer/main.tsx",
        "apps/desktop/src/shared/ipc/channels.ts",
        "apps/desktop/src/worker/untracked.ts"
      ])
    }).pipe(Effect.provide(NodeServices.layer))))

  it.live("rejects a fifth desktop process boundary", () =>
    Effect.scoped(Effect.gen(function*() {
      const root = yield* gitFixture()
      const files = yield* appSourceManifest(root)
      expect(() => assertDesktopProcessRoots(files)).toThrow()
    }).pipe(Effect.provide(NodeServices.layer))))

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
      const path = yield* Path.Path
      const files = yield* appSourceManifest(path.resolve("."))
      expect(files.filter((file) => file.split("/").at(-1)?.startsWith("_"))).toEqual([])
      expect(files.filter((file) => file.split("/").includes("lib"))).toEqual([])
    }).pipe(Effect.provide(NodeServices.layer)))

  it.live("keeps application and process roots limited to entrypoints", () =>
    Effect.gen(function*() {
      const path = yield* Path.Path
      const files = yield* appSourceManifest(path.resolve("."))
      assertDesktopProcessRoots(files)
      expect(directFiles(files, "apps/cli/cli")).toEqual(["main.ts", "output.ts"])
      expect(directFiles(files, "apps/server")).toEqual(["main.ts"])
      expect(directFiles(files, "apps/tui")).toEqual(["main.tsx"])
      expect(directFiles(files, "apps/desktop/src/main")).toEqual(["index.ts"])
      expect(directFiles(files, "apps/desktop/src/preload")).toEqual(["index.ts"])
      expect(directFiles(files, "apps/desktop/src/renderer")).toEqual(["css.d.ts", "main.tsx"])
      expect(directFiles(files, "apps/desktop/src/shared")).toEqual([])
    }).pipe(Effect.provide(NodeServices.layer)))

})
