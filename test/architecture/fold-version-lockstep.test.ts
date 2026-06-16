import { describe, expect, it } from "vitest"
import { computeFoldHash } from "../../scripts/fold-version"
import { FOLD_VERSION } from "@yodea/contracts/fold-version.generated"

// Guards that the committed FOLD_VERSION is never stale relative to the fold source.
// Importing computeFoldHash also pulls scripts/fold-version.ts into `tsc` typecheck.
describe("FOLD_VERSION generation", () => {
  it("the committed FOLD_VERSION matches a fresh hash of the fold nodes", () => {
    expect(
      FOLD_VERSION,
      "fold source changed — run `bun run gen:fold-version` and commit packages/contracts/fold-version.generated.ts"
    ).toBe(computeFoldHash())
  })
})
