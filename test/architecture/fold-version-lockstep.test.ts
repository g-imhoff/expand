import { describe, expect, it } from "vitest"
import { computeFoldHashes } from "../../scripts/fold-version"
import { FOLD_VERSIONS } from "@yodea/contracts/fold-version.generated"

// Guards that the committed FOLD_VERSIONS map is never stale relative to the fold
// source, projection by projection. Importing computeFoldHashes also pulls
// scripts/fold-version.ts into `tsc` typecheck.
describe("FOLD_VERSIONS generation", () => {
  it("the committed per-projection hashes match a fresh hash of each fold's nodes", () => {
    expect(
      FOLD_VERSIONS,
      "fold source changed — run `bun run gen:fold-version` and commit packages/contracts/fold-version.generated.ts"
    ).toEqual(computeFoldHashes())
  })
})
