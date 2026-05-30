// test/architecture/i1-cli-isolation.test.ts
// ============================================================================
// DO NOT MODIFY — architectural invariant I-1 (see docs/architecture/BOUNDARIES.md).
// This test is part of the SPECIFICATION, not the implementation. Changing or
// relaxing it changes the system's guarantees and requires an architecture-
// decision document plus architecture-owner review. CODEOWNERS routes this path.
// ============================================================================
import { execFileSync } from "node:child_process"
import { describe, expect, it } from "vitest"

describe("I-1: CLI client isolation", () => {
  it("apps/cli/cli/** does not import server-only modules", () => {
    let output = ""
    let code = 0
    try {
      // Cruise target path relocated backend -> apps/cli by the apps/ refactor.
      output = execFileSync(
        "bunx",
        ["depcruise", "apps/cli", "--config", ".dependency-cruiser.cjs"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
      )
    } catch (e: any) {
      code = typeof e.status === "number" ? e.status : 1
      output = `${e.stdout ?? ""}${e.stderr ?? ""}`
    }
    expect(output).not.toContain("cli-client-must-not-import-server")
    expect(output).not.toContain("cli-composition-only-from-server-subcommand")
    expect(code).toBe(0)
  })
})
