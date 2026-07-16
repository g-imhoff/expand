import { FOLD_VERSIONS } from "@expand/contracts/fold-version.generated"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { computeFoldHashes } from "../../scripts/fold-version"

const loadFoldHashes = Effect.try({ try: computeFoldHashes, catch: (cause) => cause })

// Guards that the committed FOLD_VERSIONS map is never stale relative to the fold
// source, projection by projection. Importing computeFoldHashes also pulls
// scripts/fold-version.ts into `tsc` typecheck.
describe("FOLD_VERSIONS generation", () => {
  it.live("the committed per-projection hashes match a fresh hash of each fold's nodes", () =>
    loadFoldHashes.pipe(
      Effect.tap((hashes) => Effect.sync(() => {
        expect(
          FOLD_VERSIONS,
          "fold source changed — run `npm run gen:fold-version` and commit packages/contracts/fold-version.generated.ts"
        ).toEqual(hashes)
      }))
    ))
})
