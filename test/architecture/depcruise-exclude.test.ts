// test/architecture/depcruise-exclude.test.ts
// ============================================================================
// DO NOT MODIFY — pins the dependency-cruiser exclude patterns as
// segment-anchored (see docs/architecture/BOUNDARIES.md, I-1 Enforcement).
// This test is part of the SPECIFICATION, not the implementation. Relaxing it
// lets source files whose names merely contain "test"/"out"/"dist" silently
// drop out of boundary enforcement. Changes require architecture-owner review;
// CODEOWNERS routes this path.
// ============================================================================
import { createRequire } from "node:module"
import { describe, expect, it } from "vitest"

const load = createRequire(import.meta.url)
const config = load("../../.dependency-cruiser.cjs") as {
  options: { exclude: { path: string | ReadonlyArray<string> } }
}

const raw = config.options.exclude.path
const patterns = (typeof raw === "string" ? [raw] : raw).map((p) => new RegExp(p))

const matchedByAny = (path: string): boolean => patterns.some((re) => re.test(path))

const MUST_STAY_CRUISED = [
  "apps/desktop/src/renderer/latest.ts",
  "packages/client-core/attestation.ts",
  "apps/cli/cli/protest.ts"
] as const

const MUST_BE_EXCLUDED = [
  "apps/server/test/unit/x.test.ts",
  "node_modules/effect/index.js",
  "apps/desktop/out/main/index.mjs",
  "dist/yodea",
  "apps/desktop/test-results/foo.png"
] as const

describe("depcruise exclude patterns (segment-anchored)", () => {
  it("keeps cruising source files that merely contain 'test'/'out'/'dist' as a substring", () => {
    for (const path of MUST_STAY_CRUISED) {
      expect(matchedByAny(path), `expected ${path} to stay cruised`).toBe(false)
    }
  })

  it("excludes test dirs, node_modules, build output, and playwright artifacts", () => {
    for (const path of MUST_BE_EXCLUDED) {
      expect(matchedByAny(path), `expected ${path} to be excluded`).toBe(true)
    }
  })
})
