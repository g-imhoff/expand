// test/architecture/depcruise-exclude.test.ts
// ============================================================================
// DO NOT MODIFY — pins the dependency-cruiser exclude patterns as
// segment-anchored (see docs/architecture/BOUNDARIES.md, I-1 Enforcement).
// This test is part of the SPECIFICATION, not the implementation. Relaxing it
// lets source files whose names merely contain "test"/"out"/"dist" silently
// drop out of boundary enforcement. Changes require architecture-owner review;
// CODEOWNERS routes this path.
//
// Client library rename (the shared client package moved to packages/client-ts;
// the `packages/client-ts/attestation.ts` path literal follows). ADR: the
// 2026-07-08 client-ts rename design spec and plan under
// docs/superpowers/specs/ and docs/superpowers/plans/.
// ============================================================================
import { createRequire } from "node:module"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"

const loadPatterns = Effect.try({
  try: () => {
    const load = createRequire(import.meta.url)
    const config = load("../../.dependency-cruiser.cjs") as {
      options: { exclude: { path: string | ReadonlyArray<string> } }
    }
    const raw = config.options.exclude.path
    return (typeof raw === "string" ? [raw] : raw).map((pattern) => new RegExp(pattern))
  },
  catch: (cause) => cause
})

const MUST_STAY_CRUISED = [
  "apps/desktop/src/renderer/latest.ts",
  "packages/client-ts/attestation.ts",
  "apps/cli/cli/protest.ts"
] as const

const MUST_BE_EXCLUDED = [
  "apps/server/test/unit/x.test.ts",
  "node_modules/effect/index.js",
  "apps/desktop/out/main/index.mjs",
  "dist/expand",
  "apps/desktop/test-results/foo.png"
] as const

describe("depcruise exclude patterns (segment-anchored)", () => {
  it.live("keeps cruising source files that merely contain 'test'/'out'/'dist' as a substring", () =>
    loadPatterns.pipe(
      Effect.tap((patterns) => Effect.sync(() => {
        for (const path of MUST_STAY_CRUISED) {
          expect(patterns.some((pattern) => pattern.test(path)), `expected ${path} to stay cruised`).toBe(false)
        }
      }))
    ))

  it.live("excludes test dirs, node_modules, build output, and playwright artifacts", () =>
    loadPatterns.pipe(
      Effect.tap((patterns) => Effect.sync(() => {
        for (const path of MUST_BE_EXCLUDED) {
          expect(patterns.some((pattern) => pattern.test(path)), `expected ${path} to be excluded`).toBe(true)
        }
      }))
    ))
})
