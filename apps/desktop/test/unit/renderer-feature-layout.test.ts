import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, FileSystem } from "effect"
import { describe, expect } from "vitest"

const repoRoot = new URL("../../../../", import.meta.url).pathname
const at = (relative: string): string => `${repoRoot}${relative}`
const expectPaths = (paths: ReadonlyArray<string>, expected: boolean) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    for (const path of paths) expect(yield* fs.exists(at(path))).toBe(expected)
  }).pipe(Effect.provide(NodeServices.layer))

describe("renderer feature folder layout", () => {
  it.effect("colocates the command feature under features/command/{components,model}", () =>
    expectPaths([
      "apps/desktop/src/renderer/features/command/components/CommandPalette.tsx",
      "apps/desktop/src/renderer/features/command/model/command-store.ts",
      "apps/desktop/src/renderer/features/command/model/hotkey.ts",
      "apps/desktop/src/renderer/features/command/model/use-command-palette-hotkey.ts"
    ], true))

  it.effect("colocates projects under components/model/pages/data", () =>
    expectPaths([
      "apps/desktop/src/renderer/features/projects/components/RenameDialog.tsx",
      "apps/desktop/src/renderer/features/projects/components/ChangeDirectoryDialog.tsx",
      "apps/desktop/src/renderer/features/projects/components/DeleteProjectDialog.tsx",
      "apps/desktop/src/renderer/features/projects/components/EditMetadataDialog.tsx",
      "apps/desktop/src/renderer/features/projects/pages/ProjectsView.tsx",
      "apps/desktop/src/renderer/features/projects/pages/Workspace.tsx",
      "apps/desktop/src/renderer/features/projects/data/use-projects.ts",
      "apps/desktop/src/renderer/features/projects/data/project-store.ts",
      "apps/desktop/src/renderer/features/projects/data/project-context.tsx"
    ], true))

  it.effect("keeps the RPC layer under renderer/rpc with the renderer-port owner", () =>
    Effect.all([
      expectPaths([
        "apps/desktop/src/renderer/rpc/renderer-port.ts",
        "apps/desktop/src/renderer/rpc/transport.ts",
        "apps/desktop/src/renderer/rpc/project-rpc.ts"
      ], true),
      expectPaths(["apps/desktop/src/renderer/rpc/server-rpc.ts"], false)
    ], { discard: true }))

  it.effect("leaves no files at the old flat command/ or projects/ locations and no removed modules", () =>
    expectPaths([
      "apps/desktop/src/renderer/command",
      "apps/desktop/src/renderer/features/projects/projects-view.tsx",
      "apps/desktop/src/renderer/features/projects/event-fold.ts",
      "apps/desktop/src/renderer/features/projects/RenameDialog.tsx",
      "apps/desktop/src/renderer/app/shell/workspace.tsx",
      "apps/desktop/src/renderer/features/projects/cache.ts",
      "apps/desktop/src/renderer/rpc/client.ts",
      "apps/desktop/src/renderer/rpc/port.ts",
      "apps/desktop/src/renderer/app/app-handle.ts",
      "apps/desktop/src/renderer/app/AppHandleProvider.tsx"
    ], false))
})
