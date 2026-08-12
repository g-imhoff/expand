import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, FileSystem, Path } from "effect"
import { describe, expect } from "vitest"
import { runCommand } from "../support/effect-process"

const exempt = new Set([
  "package-lock.json",
  "test/architecture/node-only.test.ts"
])
const containsBunReference = (source: string) =>
  /\b(?:bun|bunx)\b|@effect\/(?:platform-bun|sql-sqlite-bun)|bun:sqlite|oven-sh\/setup-bun/i.test(source) ||
  /\b[Bb]un(?=[A-Z])/.test(source)

const reviewedManifestPath = "test/architecture/manifest-orchestration.test.ts"
const reviewedManifestSourceLines = [
  '  const evaluators = new Set(["node", "tsx", "bun", "npm", "npx", "pnpm", "yarn"])',
  '      "bun -e \'harmless\'"'
] as const

interface BunReferenceDiagnostic {
  readonly path: string
  readonly line: number
  readonly token: string
  readonly sourceLine: string
}

const bunReferenceToken = (source: string) =>
  source.match(/\b(?:bun|bunx)\b|@effect\/(?:platform-bun|sql-sqlite-bun)|bun:sqlite|oven-sh\/setup-bun/i)?.[0] ??
  source.match(/\b[Bb]un(?=[A-Z])/)?.[0]

const auditBunReferences = (file: string, source: string): {
  readonly admitted: ReadonlyArray<BunReferenceDiagnostic>
  readonly diagnostics: ReadonlyArray<BunReferenceDiagnostic>
} => {
  const lines = source.split(/\r?\n/)
  const admitted: Array<BunReferenceDiagnostic> = []
  const diagnostics: Array<BunReferenceDiagnostic> = []
  const classifiedLines = new Set<number>()

  if (file === reviewedManifestPath) {
    for (const expectedSourceLine of reviewedManifestSourceLines) {
      const matches = lines.flatMap((sourceLine, index) => sourceLine === expectedSourceLine ? [index] : [])
      if (matches.length === 1) {
        const index = matches[0] as number
        classifiedLines.add(index)
        admitted.push({
          path: file,
          line: index + 1,
          token: bunReferenceToken(expectedSourceLine) as string,
          sourceLine: expectedSourceLine
        })
      } else {
        diagnostics.push({
          path: file,
          line: matches[0] === undefined ? 0 : matches[0] + 1,
          token: bunReferenceToken(expectedSourceLine) as string,
          sourceLine: expectedSourceLine
        })
      }
    }
  }

  for (const [index, sourceLine] of lines.entries()) {
    if (classifiedLines.has(index)) continue
    const token = bunReferenceToken(sourceLine)
    if (token !== undefined) diagnostics.push({ path: file, line: index + 1, token, sourceLine })
  }

  return { admitted, diagnostics }
}

describe("Node-only repository policy", () => {
  it.each(["BunServices.layer", "bunAdapter"])("detects Bun-prefixed identifier %s", (source) => {
    expect(containsBunReference(source)).toBe(true)
  })

  it.each(["bundle", "bundler"])("allows unrelated identifier %s", (source) => {
    expect(containsBunReference(source)).toBe(false)
  })

  it("admits exactly the two reviewed manifest fixture occurrences", () => {
    const source = ["before", ...reviewedManifestSourceLines, "after"].join("\n")

    expect(auditBunReferences(reviewedManifestPath, source)).toEqual({
      admitted: [
        { path: reviewedManifestPath, line: 2, token: "bun", sourceLine: reviewedManifestSourceLines[0] },
        { path: reviewedManifestPath, line: 3, token: "bun", sourceLine: reviewedManifestSourceLines[1] }
      ],
      diagnostics: []
    })
  })

  it("rejects a missing or changed reviewed manifest fixture occurrence", () => {
    const source = reviewedManifestSourceLines.join("\n").replace('"bun"', '"bunx"')

    expect(auditBunReferences(reviewedManifestPath, source).diagnostics).not.toEqual([])
  })

  it("rejects a third Bun reference in the reviewed manifest file", () => {
    const source = [...reviewedManifestSourceLines, 'const third = "bun"'].join("\n")

    expect(auditBunReferences(reviewedManifestPath, source).diagnostics).toContainEqual({
      path: reviewedManifestPath,
      line: 3,
      token: "bun",
      sourceLine: 'const third = "bun"'
    })
  })

  it("rejects a reviewed fixture line when it occurs in another file", () => {
    expect(auditBunReferences("test/architecture/other.test.ts", reviewedManifestSourceLines[0]).diagnostics).toEqual([
      {
        path: "test/architecture/other.test.ts",
        line: 1,
        token: "bun",
        sourceLine: reviewedManifestSourceLines[0]
      }
    ])
  })

  it.live("has no Bun version, lock, or adapter files", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = path.resolve(".")
      for (const file of [".bun-version", "bun.lock", "packages/client-ts/adapters/bun.ts"]) {
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
      const diagnostics: Array<BunReferenceDiagnostic> = []
      for (const file of report.stdout.split("\0").filter(Boolean)) {
        if (exempt.has(file)) continue
        const absolute = path.join(root, file)
        if (!(yield* fs.exists(absolute))) continue
        const source = yield* fs.readFileString(absolute)
        diagnostics.push(...auditBunReferences(file, source).diagnostics)
      }
      expect(diagnostics).toEqual([])
    }).pipe(Effect.provide(NodeServices.layer)))
})
