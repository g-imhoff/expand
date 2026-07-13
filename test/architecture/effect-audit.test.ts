import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, FileSystem, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { describe, expect } from "vitest"
import {
  GrepInventoryJson,
  grepCandidateClassifications,
  grepCandidateKey,
  validateGrepInventory
} from "../../scripts/effect-inventory-model"

const PackageJson = Schema.fromJsonString(Schema.Struct({
  scripts: Schema.Record(Schema.String, Schema.String)
}))

const expectedHumanGrep = "rg -n --hidden -g '*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}' -g '!.git/**' -g '!**/node_modules/**' -g '!**/{dist,out,build,coverage,test-results,playwright-report}/**' \"\\basync\\b|\\bawait\\b|new\\s+Promise\\b|\\bPromise(?:Like)?\\s*<|\\bPromise\\.(?:all|allSettled|any|race|resolve|reject)\\b|\\.(?:then|catch|finally)\\s*\\(|\\b(?:setTimeout|setInterval|setImmediate|queueMicrotask|fetch)\\s*\\(|new\\s+(?:Date|WebSocket|Worker|MessageChannel|BroadcastChannel)\\s*\\(|\\b(?:console\\.\\w+|Date\\.now|performance\\.now|Math\\.random|crypto\\.randomUUID|JSON\\.(?:parse|stringify)|process\\.[A-Za-z_$][A-Za-z0-9_$]*|(?:window|document|navigator|localStorage|sessionStorage)\\.)|\\bnode:[^'\\\"[:space:]]+|\\b[A-Za-z_$][A-Za-z0-9_$]*\\.run(?:Promise(?:Exit)?|Sync(?:Exit)?|Fork|Callback|Main)\\b\""

const repositoryRoot = Effect.fn("EffectAuditArchitectureTest.repositoryRoot")(
  function*() {
    const path = yield* Path.Path
    return yield* path.fromFileUrl(new URL("../../", import.meta.url))
  }
)()

const runAudit = Effect.fn("EffectAuditArchitectureTest.runAudit")(
  (root: string) => Effect.scoped(Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(ChildProcess.make("npm", ["run", "effect:audit"], { cwd: root }))
    const [stdout, stderr, exitCode] = yield* Effect.all([
      handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
      handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
      handle.exitCode
    ], { concurrency: "unbounded" })
    if (Number(exitCode) !== 0) {
      return yield* Effect.fail({ exitCode: Number(exitCode), stdout, stderr } as const)
    }
    return `${stdout}\n${stderr}`
  }))
)

describe("Effect audit architecture", () => {
  it.effect("keeps a sorted, unique inventory in exact bijection with indexed grep submatches", () =>
    Effect.gen(function*() {
      const root = yield* repositoryRoot
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const inventory = yield* Schema.decodeUnknownEffect(GrepInventoryJson)(
        yield* fs.readFileString(path.join(root, "effect-grep-inventory.json"))
      )
      const output = yield* runAudit(root)
      const candidateCount = grepCandidateClassifications.reduce((sum, classification) => {
        const matches = [...output.matchAll(new RegExp(`${classification}=(\\d+)`, "gu"))]
        expect(matches).toHaveLength(1)
        return sum + Number(matches[0]?.[1])
      }, 0)
      expect(validateGrepInventory(inventory)).toBeUndefined()
      expect(new Set(inventory.map(grepCandidateKey)).size).toBe(inventory.length)
      expect(candidateCount).toBe(inventory.length)
    }).pipe(Effect.provide(NodeServices.layer)), 240_000)

  it.effect("preserves the exact human grep command and has no initialization authority", () =>
    Effect.gen(function*() {
      const root = yield* repositoryRoot
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const packageJson = yield* Schema.decodeUnknownEffect(PackageJson)(
        yield* fs.readFileString(path.join(root, "package.json"))
      )
      const auditSource = yield* fs.readFileString(path.join(root, "scripts/effect-audit.ts"))
      expect(packageJson.scripts["effect:grep"]).toBe(expectedHumanGrep)
      expect(auditSource).not.toContain("initialize-grep-inventory")
      expect(auditSource).not.toContain("process.argv")
    }).pipe(Effect.provide(NodeServices.layer)))
})
