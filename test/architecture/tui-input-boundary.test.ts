// test/architecture/tui-input-boundary.test.ts
// ============================================================================
// DO NOT MODIFY — single-router input invariant (review finding C1).
// This test is part of the SPECIFICATION, not the implementation. Changing or
// relaxing it changes the system's guarantees and requires an architecture-
// decision document plus architecture-owner review. CODEOWNERS routes this path.
//
// Architectural enforcement for the TUI input framework. Ink's useInput is a
// GLOBAL broadcast: every mounted handler receives every keypress, with no
// consumption or priority. Exclusivity is only structural when exactly one
// handler exists. This test pins that single-router invariant repo-wide. ADR:
// docs/superpowers/specs/2026-06-13-tui-input-architecture-design.md
// ============================================================================
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const read = (path: string): string => readFileSync(path, "utf8")

const walk = (dir: string): Array<string> =>
  readdirSync(dir).flatMap((entry) => {
    if (entry.startsWith(".")) return []
    const full = join(dir, entry)
    if (entry === "node_modules" || entry === "out" || entry === "dist" || entry === "test-results") return []
    return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") || full.endsWith(".tsx") ? [full] : []
  })

const ROUTER_ADAPTER = join("packages/ink-input", "use-key-router-ink.tsx")

describe("TUI input boundary", () => {
  it("ink's useInput appears in exactly one file: the ink-input router adapter", () => {
    const offenders = [...walk("apps"), ...walk("packages")].filter((file) => {
      if (file === ROUTER_ADAPTER) return false
      return /\buseInput\b/.test(read(file))
    })
    expect(offenders, "raw useInput reintroduces the global-broadcast collision (review finding C1)").toEqual([])
  })

  it("ink-input pure modules never import ink", () => {
    for (const file of ["key-name.ts", "text-field.ts", "bindings.ts"]) {
      const source = read(`packages/ink-input/${file}`)
      expect(source, `${file} must stay ink-free`).not.toMatch(/from\s+"ink"/)
    }
  })

  it("ink-input is a leaf: no @yodea or effect imports", () => {
    const files = walk("packages/ink-input").filter((f) => !f.includes(join("packages/ink-input", "test")))
    for (const file of files) {
      const source = read(file)
      expect(source, `${file} must not import @yodea/* (except own modules) or effect`)
        .not.toMatch(/from\s+"(@yodea\/(?!ink-input\/)|effect)/)
    }
  })

  it("tui input policy modules stay pure (no ink imports)", () => {
    for (const file of walk("apps/tui/input")) {
      expect(read(file), `${file} must stay ink-free`).not.toMatch(/from\s+"ink"/)
    }
  })
})
