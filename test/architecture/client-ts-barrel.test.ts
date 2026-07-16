// test/architecture/client-ts-barrel.test.ts
// ============================================================================
// DO NOT MODIFY — pins the @expand/client-ts public boundary: external code may
// import only the entrypoints (index.ts, project/index.ts, server/index.ts) and adapters/*.
// This test is part of the SPECIFICATION. ADRs: the 2026-07-08 client-ts rename
// spec, the 2026-07-09 client-ts-examples spec (cruise scope includes examples),
// and the 2026-07-09 scoped-entrypoints spec (strict-core root + /project +
// /server), under docs/superpowers/specs/ and docs/superpowers/plans/.
// ============================================================================
import { createRequire } from "node:module"
import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { runCommand } from "../support/effect-process"

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
    expect(rule!.to.pathNot).toBe(
      "^packages/client-ts/(index\\.ts$|project/index\\.ts$|server/index\\.ts$|adapters/)"
    )
  })

  it.live("no external module deep-imports client-ts internals", () =>
    runCommand("npm", ["exec", "--", "depcruise", "apps", "packages", "bench", "examples", "--config", ".dependency-cruiser.cjs"]).pipe(
      Effect.tap((report) => Effect.sync(() => {
        const output = `${report.stdout}${report.stderr}`
        expect(output).not.toContain("client-ts-barrel-only")
        expect(report.exitCode).toBe(0)
      })),
      Effect.provide(NodeServices.layer)
    ))
})
