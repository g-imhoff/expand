// test/architecture/i1-cli-isolation.test.ts
// ============================================================================
// DO NOT MODIFY — architectural invariant I-1 (see docs/architecture/BOUNDARIES.md).
// This test is part of the SPECIFICATION, not the implementation. Changing or
// relaxing it changes the system's guarantees and requires an architecture-
// decision document plus architecture-owner review. CODEOWNERS routes this path.
//
// Architecture-decision record for the most recent change (generalizing I-1 from
// "the CLI client" to "no frontend imports backend internals", plus the Electron
// renderer-isolation rule, and widening the cruise scope to apps + packages):
// docs/superpowers/specs/2026-05-30-electron-ink-frontends-design.md and
// docs/superpowers/plans/2026-05-30-electron-ink-frontends.md.
// ============================================================================
import { execFileSync } from "node:child_process"
import { describe, expect, it } from "vitest"

describe("I-1: CLI client isolation", () => {
  it("apps/cli/cli/** does not import server-only modules", () => {
    let output = ""
    let code = 0
    try {
      // Cruise the full frontend + shared-client surface: apps (cli, tui, desktop)
      // and packages (contracts, client-core). I-1 now guards every frontend.
      output = execFileSync(
        "bunx",
        ["depcruise", "apps", "packages", "--config", ".dependency-cruiser.cjs"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
      )
    } catch (e: any) {
      code = typeof e.status === "number" ? e.status : 1
      output = `${e.stdout ?? ""}${e.stderr ?? ""}`
    }
    expect(output).not.toContain("frontends-must-not-import-backend")
    expect(output).not.toContain("composition-only-from-server-subcommand")
    expect(output).not.toContain("renderer-must-not-import-client-core")
    expect(code).toBe(0)
  })
})
