import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, FileSystem, Path, Schema } from "effect"
import { describe, expect } from "vitest"
import {
  EFFECT_CANDIDATE_HUMAN_COMMAND,
  validateCandidateInventory
} from "../../scripts/effect-candidate-inventory"

const PackageJson = Schema.fromJsonString(Schema.Struct({
  scripts: Schema.Record(Schema.String, Schema.String)
}))

describe("final Effect candidate architecture", () => {
  it.live("validates an exact bijection with the reusable collector", () =>
    Effect.gen(function*() {
      const path = yield* Path.Path
      const root = yield* path.fromFileUrl(new URL("../../", import.meta.url))
      const inventory = yield* validateCandidateInventory(root)

      expect(inventory.version).toBe(1)
      expect(inventory.grep.length).toBeGreaterThan(0)
    }).pipe(Effect.provide(NodeServices.layer)), 120_000)

  it.live("keeps the package regex, roots, and exclusions byte-identical to collector constants", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* path.fromFileUrl(new URL("../../", import.meta.url))
      const manifest = yield* Schema.decodeUnknownEffect(PackageJson)(
        yield* fs.readFileString(path.join(root, "package.json"))
      )

      const mutationTerms = ["update", "generate"]
      expect(manifest.scripts["effect:grep"]).toBe(EFFECT_CANDIDATE_HUMAN_COMMAND)
      expect(manifest.scripts["effect:candidates"]).toBe("vitest run test/architecture/effect-candidate-inventory.test.ts")
      expect(Object.keys(manifest.scripts).filter((name) =>
        name.includes("candidate") && mutationTerms.some((term) => name.includes(term))
      )).toEqual([])
    }).pipe(Effect.provide(NodeServices.layer)))

  it.live("removes every migration grep inventory and updater reference", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* path.fromFileUrl(new URL("../../", import.meta.url))
      const tracked = yield* fs.readFileString(path.join(root, "scripts/effect-audit.ts"))
      const removedInventory = ["effect-grep", "-inventory.json"].join("")
      const removedTerms = [
        ["migration", "debt"].join("-"),
        ["compareGrep", "Inventory"].join(""),
        ["grepInventory", "ValidationError"].join("")
      ]

      expect(yield* fs.exists(path.join(root, removedInventory))).toBe(false)
      expect(removedTerms.some((term) => tracked.includes(term))).toBe(false)
    }).pipe(Effect.provide(NodeServices.layer)))
})
