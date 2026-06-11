import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const EFFECT_PACKAGES = [
  "effect",
  "@effect/platform-bun",
  "@effect/platform-node",
  "@effect/platform-node-shared",
  "@effect/sql-sqlite-bun"
] as const

const DIRECT_PINS = [
  "effect",
  "@effect/platform-bun",
  "@effect/platform-node",
  "@effect/sql-sqlite-bun"
] as const

const installedVersion = (pkg: string): string =>
  (JSON.parse(readFileSync(`node_modules/${pkg}/package.json`, "utf8")) as { version: string })
    .version

describe("effect version lockstep", () => {
  it("installs all five Effect packages at the exact same version", () => {
    const expected = installedVersion("effect")
    for (const pkg of EFFECT_PACKAGES) {
      const version = installedVersion(pkg)
      expect(version, `expected ${pkg}@${version} to equal effect@${expected}`).toBe(expected)
    }
  })

  it("declares the direct Effect dependencies as exact pins matching the installed version", () => {
    const root = JSON.parse(readFileSync("package.json", "utf8")) as {
      dependencies: Record<string, string>
    }
    for (const name of DIRECT_PINS) {
      const declared = root.dependencies[name]
      expect(declared, `expected ${name} in package.json dependencies`).toBeDefined()
      expect(declared, `expected ${name} to be an exact pin, got ${String(declared)}`).toMatch(/^\d/)
      expect(declared, `expected ${name} pin to equal installed ${installedVersion(name)}`).toBe(
        installedVersion(name)
      )
    }
  })
})
