import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Crypto, Effect, Encoding, FileSystem, Path, Schema } from "effect"
import { describe, expect } from "vitest"
import { AuditCommandRunner, AuditCommandRunnerLive, runAudit } from "../../scripts/effect-audit"
import {
  GrepInventoryJson,
  LauncherInventoryJson,
  executableBoundaryKey,
  grepCandidateKey
} from "../../scripts/effect-inventory-model"

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

  it.effect("derives the exact launcher registry independently from Git modes and source bytes", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const crypto = yield* Crypto.Crypto
      const runner = yield* AuditCommandRunner
      const root = yield* path.fromFileUrl(new URL("../../", import.meta.url))
      const modes = yield* runner.run({
        name: "tracked-modes",
        command: "git",
        args: ["ls-files", "-s", "-z"],
        cwd: root,
        acceptedExitCodes: [0]
      })
      const selected = modes.stdout.split("\0").filter(Boolean).flatMap((record) => {
        const tab = record.indexOf("\t")
        const mode = record.slice(0, tab).split(" ").at(0) ?? ""
        const file = record.slice(tab + 1)
        return mode === "100755" || /\.(?:sh|bash|zsh)$/.test(file) ? [{ file, mode }] : []
      }).sort((left, right) => left.file < right.file ? -1 : left.file > right.file ? 1 : 0)
      const inventory = yield* Schema.decodeUnknownEffect(LauncherInventoryJson)(
        yield* fs.readFileString(path.join(root, "effect-launchers.json"))
      )
      const result = yield* runAudit({ root, mode: "check" })

      expect(modes.exitCode).toBe(0)
      expect(selected.map(({ file }) => file)).toEqual([".githooks/pre-commit", "scripts/binary-smoke.sh"])
      expect(selected.map(({ file }) => file)).toEqual(inventory.map(executableBoundaryKey))
      expect(inventory.map(executableBoundaryKey)).toEqual(selected.map(({ file }) => file))
      for (const [index, record] of inventory.entries()) {
        const selectedRecord = selected[index]
        expect(selectedRecord).toBeDefined()
        expect(record.mode).toBe(selectedRecord?.mode)
        const bytes = yield* fs.readFile(path.join(root, record.file))
        expect(record.sourceSha256).toBe(Encoding.encodeHex(yield* crypto.digest("SHA-256", bytes)))
      }
      expect(result.launcherAdded).toEqual([])
      expect(result.launcherRemoved).toEqual([])
      expect(result.launcherModeChanged).toEqual([])
      expect(result.launcherSourceChanged).toEqual([])
      expect(result.launchers.map(({ file }) => file)).toEqual(inventory.map(executableBoundaryKey))
      expect(result.launcherCounts).toEqual({
        "host-launcher": 1,
        "host-fixture": 0,
        "migration-debt": 1
      })
    }).pipe(
      Effect.provide(AuditCommandRunnerLive),
      Effect.provide(NodeServices.layer)
    ), 120_000)
})
