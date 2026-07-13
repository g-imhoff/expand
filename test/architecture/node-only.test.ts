import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const root = join(import.meta.dirname, "..", "..")
const exempt = new Set([
  "package-lock.json",
  "docs/architecture/package-lock.json",
  "test/architecture/node-only.test.ts"
])

describe("Node-only repository policy", () => {
  it("has no Bun version, lock, or adapter files", () => {
    for (const path of [".bun-version", "bun.lock", "docs/architecture/bun.lock", "packages/client-ts/adapters/bun.ts"]) {
      expect(existsSync(join(root, path)), path).toBe(false)
    }
  })

  it("contains no tracked first-party Bun runtime or command references", () => {
    const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean)
    const offenders = files
      .filter((path) => !path.startsWith("docs/superpowers/") && !exempt.has(path))
      .filter((path) => /\b(?:bun|bunx)\b|@effect\/(?:platform-bun|sql-sqlite-bun)|bun:sqlite|oven-sh\/setup-bun/i.test(readFileSync(join(root, path), "utf8")))
    expect(offenders).toEqual([])
  })
})
