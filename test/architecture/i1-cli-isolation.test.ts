// test/architecture/i1-cli-isolation.test.ts
// ============================================================================
// DO NOT MODIFY — architectural invariant I-1 (see docs/architecture/BOUNDARIES.md).
// This test is part of the SPECIFICATION, not the implementation. Changing or
// relaxing it changes the system's guarantees and requires an architecture-
// decision document plus architecture-owner review. CODEOWNERS routes this path.
//
// Architecture-decision record for the most recent change (generalizing I-1 from
// "the CLI client" to "no frontend imports backend internals", plus the Electron
// renderer-isolation rule, and widening the cruise scope to apps + packages):
// docs/superpowers/specs/2026-05-30-electron-ink-frontends-design.md and
// docs/superpowers/plans/2026-05-30-electron-ink-frontends.md.
//
// Desktop architecture redesign (typed RPC seam over a MessagePort; the
// `renderer-must-not-import-client-ts` rule extended to cover the preload,
// which exposes only the registry-derived typed IPC surface (originally a pure
// port broker; amended by the 2026-06-12 typed-IPC ADR)). Re-proven non-vacuous: a forbidden
// preload -> client-ts import trips the rule. ADR:
// docs/superpowers/specs/2026-06-01-desktop-architecture-design.md and
// docs/superpowers/plans/2026-06-01-desktop-architecture.md.
//
// Client library rename (the shared client package moved to packages/client-ts;
// the I-1 glob and the `renderer-must-not-import-client-ts` rule name follow).
// ADR: the 2026-07-08 client-ts rename design spec and plan under
// docs/superpowers/specs/ and docs/superpowers/plans/.
// ============================================================================
import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { runCommand } from "../support/effect-process"

describe("I-1: CLI client isolation", () => {
  it.live("apps/cli/cli/** does not import server-only modules", () =>
    runCommand("npm", ["exec", "--", "depcruise", "apps", "packages", "--config", ".dependency-cruiser.cjs"]).pipe(
      Effect.tap((report) => Effect.sync(() => {
        const output = `${report.stdout}${report.stderr}`
        expect(output).not.toContain("frontends-must-not-import-backend")
        expect(output).not.toContain("composition-only-from-server-subcommand")
        expect(output).not.toContain("renderer-must-not-import-client-ts")
        expect(report.exitCode).toBe(0)
      })),
      Effect.provide(NodeServices.layer)
    ))
})
