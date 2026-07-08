// test/architecture/client-ts-barrel.test.ts
// ============================================================================
// DO NOT MODIFY — pins the @expand/client-ts public boundary: external code may
// import only the barrel (index.ts) and adapters/*. This test is part of the
// SPECIFICATION. ADR: the 2026-07-08 client-ts rename design spec and plan under
// docs/superpowers/specs/ and docs/superpowers/plans/.
// The cruise scope was widened to include `examples` per the 2026-07-09
// client-ts-examples design spec/plan (examples/client-ts is a barrel-enforced
// external consumer), so the barrel rule now guards example code too.
// ============================================================================
import { createRequire } from "node:module"
import { execFileSync } from "node:child_process"
import { describe, expect, it } from "vitest"

const load = createRequire(import.meta.url)
const config = load("../../.dependency-cruiser.cjs") as {
  forbidden: ReadonlyArray<{
    name: string
    from: { path?: string; pathNot?: string }
    to: { path?: string; pathNot?: string }
  }>
}

describe("@expand/client-ts barrel-only boundary", () => {
  it("defines the client-ts-barrel-only forbidden rule", () => {
    const rule = config.forbidden.find((r) => r.name === "client-ts-barrel-only")
    expect(rule, "rule client-ts-barrel-only must exist").toBeDefined()
    expect(rule!.from.pathNot).toBe("^packages/client-ts/")
    expect(rule!.to.path).toBe("^packages/client-ts/")
    expect(rule!.to.pathNot).toBe("^packages/client-ts/(index\\.ts$|adapters/)")
  })

  it("no external module deep-imports client-ts internals", () => {
    let output = ""
    let code = 0
    try {
      output = execFileSync(
        "bunx",
        ["depcruise", "apps", "packages", "bench", "examples", "--config", ".dependency-cruiser.cjs"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
      )
    } catch (e: any) {
      code = typeof e.status === "number" ? e.status : 1
      output = `${e.stdout ?? ""}${e.stderr ?? ""}`
    }
    expect(output).not.toContain("client-ts-barrel-only")
    expect(code).toBe(0)
  })
})
