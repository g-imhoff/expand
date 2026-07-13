import { describe, expect, it } from "vitest"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

// Fitness test: the codebase must contain no dead code. Knip analyzes the whole
// module graph across both workspaces (root + apps/desktop) and reports unused
// files, exports, exported types, and dependencies; it exits non-zero on any
// finding. Configuration and the rationale for every suppression live in knip.jsonc.
//
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

describe("no dead code", () => {
  it("knip finds no unused files, exports, types, or dependencies", () => {
    const result = spawnSync("npm", ["exec", "--", "knip", "--no-progress"], {
      cwd: repoRoot,
      encoding: "utf8"
    })
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim()
    expect(
      result.status,
      output.length > 0
        ? `knip reported dead code (delete it, un-export it, or justify in knip.jsonc):\n\n${output}`
        : `knip failed to run (status ${String(result.status)})`
    ).toBe(0)
  }, 120_000)
})
