import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, FileSystem, Path, Schema } from "effect"
import { describe, expect } from "vitest"
import {
  EFFECT_CANDIDATE_ARGS,
  EFFECT_CANDIDATE_EXCLUSIONS,
  EFFECT_CANDIDATE_HUMAN_COMMAND,
  EFFECT_CANDIDATE_PATTERN,
  EFFECT_CANDIDATE_ROOTS,
  validateCandidateGrepCommand,
  validateCandidateInventory
} from "../../scripts/effect-candidate-inventory"

const PackageJson = Schema.fromJsonString(Schema.Struct({
  scripts: Schema.Record(Schema.String, Schema.String)
}))

const approvedPattern = String.raw`\basync\b|\bawait\b|new\s+Promise\b|\bPromise(?:Like)?\s*<|\bPromise\.(?:all|allSettled|any|race|resolve|reject)\b|\.(?:then|catch|finally)\s*\(|\b(?:setTimeout|setInterval|setImmediate|queueMicrotask|fetch)\s*\(|new\s+(?:Date|WebSocket|Worker|MessageChannel|BroadcastChannel)\s*\(|\b(?:console\.\w+|Date\.now|performance\.now|Math\.random|crypto\.randomUUID|JSON\.(?:parse|stringify)|process\.[A-Za-z_$][A-Za-z0-9_$]*|(?:window|document|navigator|localStorage|sessionStorage)\.)|\bnode:[^'"[:space:]]+|\b[A-Za-z_$][A-Za-z0-9_$]*\.run(?:Promise(?:Exit)?|Sync(?:Exit)?|Fork|Callback|Main)\b`
const approvedExtensions = "*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"
const approvedExclusions = [
  "!.git/**",
  "!**/node_modules/**",
  "!**/{dist,out,build,coverage,test-results,playwright-report}/**"
] as const
const approvedRoots = ["."] as const
const approvedArgs = [
  "-n",
  "--hidden",
  "-g",
  approvedExtensions,
  "-g",
  "!.git/**",
  "-g",
  "!**/node_modules/**",
  "-g",
  "!**/{dist,out,build,coverage,test-results,playwright-report}/**",
  approvedPattern,
  "."
] as const
const approvedCommand = `rg -n --hidden -g '${approvedExtensions}' -g '!.git/**' -g '!**/node_modules/**' -g '!**/{dist,out,build,coverage,test-results,playwright-report}/**' "${approvedPattern.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}" .`

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
      expect(EFFECT_CANDIDATE_PATTERN).toBe(approvedPattern)
      expect(EFFECT_CANDIDATE_ROOTS).toEqual(approvedRoots)
      expect(EFFECT_CANDIDATE_EXCLUSIONS).toEqual(approvedExclusions)
      expect(EFFECT_CANDIDATE_ARGS).toEqual(approvedArgs)
      expect(EFFECT_CANDIDATE_HUMAN_COMMAND).toBe(approvedCommand)
      expect(manifest.scripts["effect:grep"]).toBe(approvedCommand)
      expect(manifest.scripts["effect:grep"]).toBe(EFFECT_CANDIDATE_HUMAN_COMMAND)
      expect(manifest.scripts["effect:candidates"]).toBe("vitest run test/architecture/effect-candidate-inventory.test.ts")
      expect(Object.keys(manifest.scripts).filter((name) =>
        name.includes("candidate") && mutationTerms.some((term) => name.includes(term))
      )).toEqual([])
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects pattern, root, exclusion, extension, and argument-order drift", () =>
    Effect.gen(function*() {
      const mutations = [
        approvedCommand.replace("async", "asyncFunction"),
        approvedCommand.slice(0, -2),
        approvedCommand.replace("-g '!.git/**'", ""),
        approvedCommand.replace(approvedExtensions, "*.{ts,tsx}"),
        approvedCommand.replace("-n --hidden", "--hidden -n")
      ]
      yield* validateCandidateGrepCommand(approvedCommand)
      for (const mutation of mutations) {
        const result = yield* Effect.exit(validateCandidateGrepCommand(mutation))
        expect(result._tag).toBe("Failure")
      }
    }))

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
