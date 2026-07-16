import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, FileSystem, Path } from "effect"
import { describe, expect } from "vitest"
import { runCommand } from "../support/effect-process"

const exempt = new Set([
  "package-lock.json",
  "docs/architecture/package-lock.json",
  "test/architecture/node-only.test.ts"
])
const containsBunReference = (source: string) =>
  /\b(?:bun|bunx)\b|@effect\/(?:platform-bun|sql-sqlite-bun)|bun:sqlite|oven-sh\/setup-bun/i.test(source) ||
  /\b[Bb]un(?=[A-Z])/.test(source)

describe("Node-only repository policy", () => {
  it.each(["BunServices.layer", "bunAdapter"])("detects Bun-prefixed identifier %s", (source) => {
    expect(containsBunReference(source)).toBe(true)
  })

  it.each(["bundle", "bundler"])("allows unrelated identifier %s", (source) => {
    expect(containsBunReference(source)).toBe(false)
  })

  it.live("has no Bun version, lock, or adapter files", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = path.resolve(".")
      for (const file of [".bun-version", "bun.lock", "docs/architecture/bun.lock", "packages/client-ts/adapters/bun.ts"]) {
        expect(yield* fs.exists(path.join(root, file)), file).toBe(false)
      }
    }).pipe(Effect.provide(NodeServices.layer)))

  it.live("contains no tracked first-party Bun runtime or command references", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = path.resolve(".")
      const report = yield* runCommand("git", ["ls-files", "-z"], { cwd: root })
      expect(report.exitCode, report.stderr).toBe(0)
      const offenders: Array<string> = []
      for (const file of report.stdout.split("\0").filter(Boolean)) {
        if (file.startsWith("docs/superpowers/") || exempt.has(file)) continue
        if (containsBunReference(yield* fs.readFileString(path.join(root, file)))) offenders.push(file)
      }
      expect(offenders).toEqual([])
    }).pipe(Effect.provide(NodeServices.layer)))
})
