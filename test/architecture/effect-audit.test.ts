import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, FileSystem, Path, Schema } from "effect"
import { describe, expect } from "vitest"
import { AuditCommandRunnerLive, runAudit } from "../../scripts/effect-audit"
import { GrepInventoryJson, grepCandidateKey } from "../../scripts/effect-inventory-model"

const PackageJson = Schema.fromJsonString(Schema.Struct({
  scripts: Schema.Struct({ "effect:grep": Schema.String })
}))

const approvedHumanCommand = String.raw`rg -n --hidden -g '*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}' -g '!.git/**' -g '!**/node_modules/**' -g '!**/{dist,out,build,coverage,test-results,playwright-report}/**' "\\basync\\b|\\bawait\\b|new\\s+Promise\\b|\\bPromise(?:Like)?\\s*<|\\bPromise\\.(?:all|allSettled|any|race|resolve|reject)\\b|\\.(?:then|catch|finally)\\s*\\(|\\b(?:setTimeout|setInterval|setImmediate|queueMicrotask|fetch)\\s*\\(|new\\s+(?:Date|WebSocket|Worker|MessageChannel|BroadcastChannel)\\s*\\(|\\b(?:console\\.\\w+|Date\\.now|performance\\.now|Math\\.random|crypto\\.randomUUID|JSON\\.(?:parse|stringify)|process\\.[A-Za-z_$][A-Za-z0-9_$]*|(?:window|document|navigator|localStorage|sessionStorage)\\.)|\\bnode:[^'\"[:space:]]+|\\b[A-Za-z_$][A-Za-z0-9_$]*\\.run(?:Promise(?:Exit)?|Sync(?:Exit)?|Fork|Callback|Main)\\b"`

describe("Effect grep architecture", () => {
  it.effect("keeps the approved human grep command unchanged", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* path.fromFileUrl(new URL("../../", import.meta.url))
      const packageJson = yield* Schema.decodeUnknownEffect(PackageJson)(
        yield* fs.readFileString(path.join(root, "package.json"))
      )

      expect(packageJson.scripts["effect:grep"]).toBe(approvedHumanCommand)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("resolves every indexed grep submatch to exactly one inventory record in both directions", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* path.fromFileUrl(new URL("../../", import.meta.url))
      const result = yield* runAudit({ root, mode: "check" })
      const inventory = yield* Schema.decodeUnknownEffect(GrepInventoryJson)(
        yield* fs.readFileString(path.join(root, "effect-grep-inventory.json"))
      )
      const currentKeys = result.grepCandidates.map(grepCandidateKey)
      const inventoryKeys = inventory.map(grepCandidateKey)

      expect(result.grepAdded).toEqual([])
      expect(result.grepRemoved).toEqual([])
      expect(currentKeys.length).toBeGreaterThan(0)
      expect(new Set(currentKeys).size).toBe(currentKeys.length)
      expect(currentKeys).toEqual(inventoryKeys)
    }).pipe(
      Effect.provide(AuditCommandRunnerLive),
      Effect.provide(NodeServices.layer)
    ), 120_000)
})
