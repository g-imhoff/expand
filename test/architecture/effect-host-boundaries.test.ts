import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, Path, Schema } from "effect"
import { describe, expect } from "vitest"
import { effectHostBoundaries } from "../../eslint-rules/effect-host-boundaries.mjs"
import { runCommand } from "../support/effect-process"

const EslintMessage = Schema.Struct({
  ruleId: Schema.NullOr(Schema.String),
  message: Schema.String
})

const EslintResult = Schema.Struct({
  filePath: Schema.String,
  messages: Schema.Array(EslintMessage)
})

const EslintJson = Schema.fromJsonString(Schema.Array(EslintResult))

const boundaryIdentity = (boundary: (typeof effectHostBoundaries)[number]) =>
  [boundary.file, boundary.declaration, boundary.construct, boundary.occurrence].join("\u0000")

describe("Effect host-boundary registry", () => {
  it("keeps every host boundary exact and unique", () => {
    const identities = effectHostBoundaries.map(boundaryIdentity)
    expect(new Set(identities).size).toBe(identities.length)
    for (const boundary of effectHostBoundaries) {
      expect(boundary.file).toMatch(/\.(?:[cm]?[jt]sx?)$/)
      expect(boundary.file).not.toMatch(/(?:^|\/)(?:\.{1,2})(?:\/|$)|[*?\[\]{}]|\\/)
      expect(boundary.declaration.trim()).not.toBe("")
      expect(boundary.host.trim()).not.toBe("")
      expect(boundary.construct.trim()).not.toBe("")
      expect(boundary.occurrence).toBeGreaterThanOrEqual(0)
    }
  })

  it.live("resolves every permanent boundary through tracked configured ESLint", () =>
    Effect.gen(function*() {
      const path = yield* Path.Path
      const root = path.resolve(".")
      const trackedReport = yield* runCommand("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
      expect(trackedReport.exitCode, trackedReport.stderr).toBe(0)
      const tracked = new Set(trackedReport.stdout.split("\0").filter(Boolean))
      const eslint = yield* runCommand("eslint", ["--config", "eslint.effect.config.mjs", ".", "--format", "json"])
      expect([0, 1]).toContain(eslint.exitCode)
      const results = yield* Schema.decodeUnknownEffect(EslintJson)(eslint.stdout)
      const resultCounts = new Map<string, number>()
      for (const result of results) {
        const file = path.relative(root, path.resolve(result.filePath)).split(path.sep).join("/")
        resultCounts.set(file, (resultCounts.get(file) ?? 0) + 1)
      }

      for (const boundary of effectHostBoundaries) {
        expect(tracked.has(boundary.file), `untracked boundary ${boundary.file}`).toBe(true)
        expect(resultCounts.get(boundary.file), `unconsumed boundary ${boundary.file}`).toBe(1)
      }
      expect(results.flatMap((result) => result.messages.map((message) => ({
        file: path.relative(root, path.resolve(result.filePath)).split(path.sep).join("/"),
        ...message
      })))).toEqual([])
    }).pipe(Effect.provide(NodeServices.layer)), 120_000)
})
