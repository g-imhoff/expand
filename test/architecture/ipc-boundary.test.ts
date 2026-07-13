// test/architecture/ipc-boundary.test.ts
// ============================================================================
// DO NOT MODIFY — architectural invariant I-1 (see docs/architecture/BOUNDARIES.md).
// This test is part of the SPECIFICATION, not the implementation. Changing or
// relaxing it changes the system's guarantees and requires an architecture-
// decision document plus architecture-owner review. CODEOWNERS routes this path.
//
// Architectural enforcement for the typed IPC framework (BOUNDARIES.md I-1,
// amended). ADR: docs/superpowers/specs/2026-06-12-typed-ipc-framework-design.md
// and docs/superpowers/plans/2026-06-12-typed-ipc-framework.md.
// ============================================================================
import { execFileSync } from "node:child_process"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const read = (path: string): string => readFileSync(path, "utf8")

const walk = (dir: string): Array<string> =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (entry === "node_modules" || entry === "out" || entry === "dist" || entry === "test-results") return []
    return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") || full.endsWith(".tsx") ? [full] : []
  })

describe("typed IPC boundary", () => {
  it("pure framework modules never import electron", () => {
    for (const file of ["contract.ts", "preload.ts", "main.ts", "renderer.ts"]) {
      const source = read(`packages/electron-ipc/${file}`)
      expect(source, `${file} must stay electron-free`).not.toMatch(/from\s+"electron"/)
    }
  })

  it("only the electron adapters touch ipcMain/ipcRenderer/contextBridge", () => {
    const allowed = new Set([
      join("packages/electron-ipc", "preload-electron.ts"),
      join("packages/electron-ipc", "main-electron.ts")
    ])
    const files = [...walk("apps/desktop/src"), ...walk("packages")]
    for (const file of files) {
      if (allowed.has(file)) continue
      if (file.includes("/test/")) continue
      const source = read(file)
      expect(source, `${file} must not use raw Electron IPC primitives`).not.toMatch(
        /\b(ipcMain|ipcRenderer|contextBridge)\b/
      )
    }
  })

  it("the preload imports only electron-ipc modules and the registry", () => {
    const source = read("apps/desktop/src/preload/index.ts")
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1])
    for (const specifier of imports) {
      expect(
        specifier === "@expand/desktop/shared/ipc/channels" || specifier!.startsWith("@expand/electron-ipc/"),
        `preload imports forbidden module: ${specifier}`
      ).toBe(true)
    }
  })

  it("no legacy magic channel strings survive outside the framework", () => {
    const files = [...walk("apps/desktop/src")]
    for (const file of files) {
      const source = read(file)
      expect(source, `${file} contains a legacy channel literal`).not.toMatch(/"expand:port-request"|"expand:port"/)
    }
  })

  it("dependency-cruiser IPC rules hold", () => {
    let output = ""
    let code = 0
    try {
      output = execFileSync("npm", ["exec", "--", "depcruise", "apps", "packages", "--config", ".dependency-cruiser.cjs"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      })
    } catch (e: any) {
      code = typeof e.status === "number" ? e.status : 1
      output = `${e.stdout ?? ""}${e.stderr ?? ""}`
    }
    expect(output).not.toContain("electron-ipc-package-isolated")
    expect(output).not.toContain("shared-ipc-stays-pure")
    expect(output).not.toContain("preload-imports-allowlist")
    expect(code).toBe(0)
  })
})
