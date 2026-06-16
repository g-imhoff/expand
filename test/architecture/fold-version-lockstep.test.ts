import { describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

// DO NOT MODIFY casually. Locks the projection fold so it cannot change without a
// conscious FOLD_VERSION decision. If this test fails the fold source changed:
//  (1) decide whether re-folding the SAME past events now yields a DIFFERENT Project
//      — if yes, bump FOLD_VERSION in packages/contracts/project.ts;
//  (2) set EXPECTED_FOLD_HASH below to the actual hash printed in the failure.
const EXPECTED_FOLD_HASH = "edd8dacda25e1ed7dd1deeee877ce7f428740306336f6be9b06fccc4253cda76"

const here = dirname(fileURLToPath(import.meta.url))
const foldFile = join(here, "..", "..", "packages", "contracts", "project.ts")

describe("FOLD_VERSION lockstep", () => {
  it("the projection fold has not changed without acknowledgement", () => {
    const actual = createHash("sha256").update(readFileSync(foldFile, "utf8")).digest("hex")
    expect(
      actual,
      `fold source changed — review it, bump FOLD_VERSION if behavior changed, then set EXPECTED_FOLD_HASH to: ${actual}`
    ).toBe(EXPECTED_FOLD_HASH)
  })
})
