import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const repoRoot = fileURLToPath(new URL("../../", import.meta.url))
const at = (rel: string): string => `${repoRoot}${rel}`

describe("renderer feature folder layout", () => {
  it("colocates the command feature under features/command/{components,model}", () => {
    expect(existsSync(at("apps/desktop/src/renderer/features/command/components/CommandPalette.tsx"))).toBe(true)
    expect(existsSync(at("apps/desktop/src/renderer/features/command/model/command-store.ts"))).toBe(true)
    expect(existsSync(at("apps/desktop/src/renderer/features/command/model/hotkey.ts"))).toBe(true)
    expect(existsSync(at("apps/desktop/src/renderer/features/command/model/use-command-palette-hotkey.ts"))).toBe(true)
  })

  it("colocates projects under components/model/pages/data", () => {
    expect(existsSync(at("apps/desktop/src/renderer/features/projects/components/RenameDialog.tsx"))).toBe(true)
    expect(existsSync(at("apps/desktop/src/renderer/features/projects/components/ChangeDirectoryDialog.tsx"))).toBe(true)
    expect(existsSync(at("apps/desktop/src/renderer/features/projects/components/DeleteProjectDialog.tsx"))).toBe(true)
    expect(existsSync(at("apps/desktop/src/renderer/features/projects/components/EditMetadataDialog.tsx"))).toBe(true)
    expect(existsSync(at("apps/desktop/src/renderer/features/projects/pages/ProjectsView.tsx"))).toBe(true)
    expect(existsSync(at("apps/desktop/src/renderer/features/projects/pages/Workspace.tsx"))).toBe(true)
    expect(existsSync(at("apps/desktop/src/renderer/features/projects/model/event-fold.ts"))).toBe(true)
    expect(existsSync(at("apps/desktop/src/renderer/features/projects/data/use-projects.ts"))).toBe(true)
    expect(existsSync(at("apps/desktop/src/renderer/features/projects/data/project-store.ts"))).toBe(true)
  })

  it("keeps the RPC layer under renderer/rpc with the renderer-port owner", () => {
    expect(existsSync(at("apps/desktop/src/renderer/rpc/renderer-port.ts"))).toBe(true)
    expect(existsSync(at("apps/desktop/src/renderer/rpc/transport.ts"))).toBe(true)
    expect(existsSync(at("apps/desktop/src/renderer/rpc/project-rpc.ts"))).toBe(true)
    expect(existsSync(at("apps/desktop/src/renderer/rpc/server-rpc.ts"))).toBe(true)
  })

  it("leaves no files at the old flat command/ or projects/ locations and no removed modules", () => {
    expect(existsSync(at("apps/desktop/src/renderer/command"))).toBe(false)
    expect(existsSync(at("apps/desktop/src/renderer/features/projects/projects-view.tsx"))).toBe(false)
    expect(existsSync(at("apps/desktop/src/renderer/features/projects/event-fold.ts"))).toBe(false)
    expect(existsSync(at("apps/desktop/src/renderer/features/projects/RenameDialog.tsx"))).toBe(false)
    expect(existsSync(at("apps/desktop/src/renderer/app/shell/workspace.tsx"))).toBe(false)
    expect(existsSync(at("apps/desktop/src/renderer/features/projects/cache.ts"))).toBe(false)
    expect(existsSync(at("apps/desktop/src/renderer/rpc/client.ts"))).toBe(false)
    expect(existsSync(at("apps/desktop/src/renderer/rpc/port.ts"))).toBe(false)
  })
})
