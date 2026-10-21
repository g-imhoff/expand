import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, FileSystem, Path, Schema } from "effect"
import { describe, expect } from "vitest"
import { runCommand } from "../support/effect-process"

const StringMap = Schema.Record(Schema.String, Schema.String)
const PackageJson = Schema.fromJsonString(Schema.Struct({
  scripts: StringMap,
  devDependencies: StringMap
}))
const InstalledLanguageServicePackageJson = Schema.fromJsonString(Schema.Struct({
  version: Schema.String
}))
const PluginJson = Schema.Struct({
  name: Schema.String,
  diagnosticSeverity: Schema.optionalKey(StringMap),
  includeSuggestionsInTsc: Schema.Boolean,
  ignoreEffectErrorsInTscExitCode: Schema.Boolean,
  ignoreEffectWarningsInTscExitCode: Schema.Boolean,
  ignoreEffectSuggestionsInTscExitCode: Schema.Boolean
})
const RootConfigJson = Schema.fromJsonString(Schema.Struct({
  compilerOptions: Schema.Struct({ plugins: Schema.Array(PluginJson) })
}))
const WorkspaceConfigJson = Schema.fromJsonString(Schema.Struct({
  extends: Schema.String,
  include: Schema.Array(Schema.String),
  exclude: Schema.Array(Schema.String)
}))
const DesktopConfigJson = Schema.fromJsonString(Schema.Struct({
  extends: Schema.String,
  exclude: Schema.Array(Schema.String),
  include: Schema.Array(Schema.String)
}))

const readJson = Effect.fn("EffectLanguageServiceTest.readJson")(
  function* <S extends Schema.Top>(file: string, schema: S) {
    const fs = yield* FileSystem.FileSystem
    return yield* Schema.decodeUnknownEffect(schema)(yield* fs.readFileString(file))
  }
)

const isTypeScriptFile = (file: string) =>
  file.endsWith(".ts") || file.endsWith(".tsx") || file.endsWith(".mts") || file.endsWith(".cts")

const normalizedRepositoryFiles = Effect.fn("EffectLanguageServiceTest.normalizedRepositoryFiles")(
  function*(files: ReadonlyArray<string>) {
    const path = yield* Path.Path
    const root = path.resolve(".")
    return Array.from(new Set(files.map((file) =>
      path.relative(root, path.resolve(file)).split(path.sep).join("/")
    ))).sort()
  }
)

const trackedTypeScriptFiles = Effect.gen(function*() {
  const report = yield* runCommand("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
  expect(report.exitCode, report.stderr).toBe(0)
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = path.resolve(".")
  const existing: Array<string> = []
  for (const file of report.stdout.split("\0").filter(isTypeScriptFile)) {
    if (yield* fs.exists(path.join(root, file))) existing.push(file)
  }
  return yield* normalizedRepositoryFiles(existing)
})

// The two module files inspected by `effect-language-service check` (see
// getModuleFilePath in the language-service CLI: "typescript" resolves to
// lib/typescript.js and "tsc" resolves to lib/_tsc.js). Each patched file
// carries exactly one `"use effect-lsp-patch-version <version>";` marker, so
// the two files together account for the two "patched with version" lines the
// CLI used to print.
const patchedTypeScriptModules = [
  "node_modules/typescript/lib/typescript.js",
  "node_modules/typescript/lib/_tsc.js"
] as const

const hasGlobMagic = (pattern: string): boolean => /[*?{}[\]]/.test(pattern)

const globToRegExp = (pattern: string): RegExp => {
  let source = ""
  for (let i = 0; i < pattern.length;) {
    const char = pattern[i]
    if (char === undefined) {
      i += 1
      continue
    }
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          source += "(.*/)?"
          i += 3
        } else {
          source += ".*"
          i += 2
        }
      } else {
        source += "[^/]*"
        i += 1
      }
    } else if (char === "?") {
      source += "[^/]"
      i += 1
    } else if ("\\.+()|^$|{}[]".includes(char)) {
      source += `\\${char}`
      i += 1
    } else {
      source += char
      i += 1
    }
  }
  return new RegExp(`^${source}$`)
}

const compileWorkspaceGlobs = (
  include: ReadonlyArray<string>,
  exclude: ReadonlyArray<string>
) => {
  const includeTests = include.map((pattern) =>
    hasGlobMagic(pattern)
      ? (relative: string) => globToRegExp(pattern).test(relative)
      : (relative: string) => relative === pattern || relative.startsWith(`${pattern}/`)
  )
  const excludeTests = exclude.map((pattern) => {
    const expression = globToRegExp(pattern)
    return (relative: string) => expression.test(relative)
  })
  // Directories that can never contribute a file matching the excludes are
  // pruned during the walk instead of being descended into. `.git` is always
  // pruned: the workspace includes name top-level source directories plus
  // root-level files, so no path under `.git/` can match them.
  const prunedDirectories = new Set<string>([".git"])
  for (const pattern of exclude) {
    const match = /^\*\*\/([^/*?{}[\]\\]+)\/\*\*$/.exec(pattern)
    if (match?.[1] !== undefined) prunedDirectories.add(match[1])
  }
  return {
    includeFile: (relative: string) => includeTests.some((test) => test(relative)),
    excludeFile: (relative: string) => excludeTests.some((test) => test(relative)),
    prunedDirectories
  }
}

const resolvedWorkspaceFiles = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = path.resolve(".")
  const workspaceConfig = yield* readJson("tsconfig.workspace.json", WorkspaceConfigJson)
  const globs = compileWorkspaceGlobs(workspaceConfig.include, workspaceConfig.exclude)
  const collected: Array<string> = []
  const visited = new Set<string>()
  const pending: Array<string> = [root]
  while (pending.length > 0) {
    const directory = pending.pop() as string
    const real = yield* fs.realPath(directory)
    if (visited.has(real)) continue
    visited.add(real)
    const entries = yield* fs.readDirectory(directory)
    for (const entry of entries) {
      const full = path.join(directory, entry)
      const info = yield* fs.stat(full)
      if (info.type === "Directory") {
        if (!globs.prunedDirectories.has(entry)) pending.push(full)
      } else if (info.type === "File" && isTypeScriptFile(entry)) {
        const relative = path.relative(root, full).split(path.sep).join("/")
        if (globs.includeFile(relative) && !globs.excludeFile(relative)) collected.push(relative)
      }
    }
  }
  return yield* normalizedRepositoryFiles(collected)
})

const expectedScripts = {
  prepare: "effect-language-service patch",
  typecheck: "tsc --noEmit -p tsconfig.workspace.json"
}

const expectedDiagnosticSeverity = {
  asyncFunction: "error",
  newPromise: "error",
  nodeBuiltinImport: "off",
  globalConsole: "error",
  globalConsoleInEffect: "error",
  globalDate: "error",
  globalDateInEffect: "error",
  globalFetch: "error",
  globalFetchInEffect: "error",
  globalRandom: "error",
  globalRandomInEffect: "error",
  globalTimers: "error",
  globalTimersInEffect: "error",
  cryptoRandomUUID: "error",
  cryptoRandomUUIDInEffect: "error",
  processEnv: "off",
  processEnvInEffect: "error",
  preferSchemaOverJson: "error",
  floatingEffect: "error",
  lazyPromiseInEffectSync: "error",
  runEffectInsideEffect: "error",
  tryCatchInEffectGen: "error",
  globalErrorInEffectCatch: "error",
  globalErrorInEffectFailure: "error",
  effectFnOpportunity: "error"
}

const expectedWorkspaceIncludes = [
  "apps",
  "packages",
  "scripts",
  "examples",
  "test",
  "eslint-rules",
  "*.ts",
  "*.tsx",
  "*.mts",
  "*.cts"
]

const expectedWorkspaceExcludes = [
  "**/node_modules/**",
  "**/dist/**",
  "**/out/**",
  "**/build/**",
  "**/coverage/**",
  "**/test-results/**",
  "**/playwright-report/**",
  "**/.worktrees/**"
]

describe("Effect language service diagnostics", () => {
  it.live("pins the official packages, scripts, plugin, and workspace project", () =>
    Effect.gen(function*() {
      const packageJson = yield* readJson("package.json", PackageJson)
      const rootConfig = yield* readJson("tsconfig.json", RootConfigJson)
      const workspaceConfig = yield* readJson("tsconfig.workspace.json", WorkspaceConfigJson)
      const desktopConfig = yield* readJson("apps/desktop/tsconfig.json", DesktopConfigJson)

      expect(packageJson.devDependencies["@effect/language-service"]).toBe("0.86.6")
      expect(packageJson.devDependencies["@effect/vitest"]).toBe("4.0.0")
      expect(packageJson.scripts).toMatchObject(expectedScripts)
      expect(rootConfig.compilerOptions.plugins).toEqual([{
        name: "@effect/language-service",
        includeSuggestionsInTsc: true,
        ignoreEffectErrorsInTscExitCode: false,
        ignoreEffectWarningsInTscExitCode: false,
        ignoreEffectSuggestionsInTscExitCode: false,
        diagnosticSeverity: expectedDiagnosticSeverity
      }])
      expect(rootConfig.compilerOptions.plugins.at(-1)?.diagnosticSeverity).not.toHaveProperty(
        "schemaSyncInEffect"
      )
      expect(workspaceConfig).toEqual({
        extends: "./tsconfig.json",
        include: expectedWorkspaceIncludes,
        exclude: expectedWorkspaceExcludes
      })
      expect(desktopConfig).toEqual({
        extends: "../../tsconfig.json",
        exclude: [],
        include: [
          "src",
          "e2e",
          "test/integration",
          "test/ui",
          "test/unit/*.test.ts",
          "test/unit/*.test.tsx",
          "../../packages/contracts/globals.d.ts"
        ]
      })
    }).pipe(Effect.provide(NodeServices.layer)))

  it.live("keeps TypeScript patched so typecheck enforces Effect diagnostics", () =>
    Effect.gen(function*() {
      // The full `npm run typecheck` compile is intentionally not executed
      // here: the CI quality job already runs `npm run typecheck` on every
      // push and pull request (see .github/workflows/ci.yml), so re-running
      // the noEmit compile inside this test only adds wall time without an
      // assertion signal CI does not already provide.
      const fs = yield* FileSystem.FileSystem
      const packageJson = yield* readJson("package.json", PackageJson)
      const installed = yield* readJson(
        "node_modules/@effect/language-service/package.json",
        InstalledLanguageServicePackageJson
      )
      expect(installed.version).toBe(packageJson.devDependencies["@effect/language-service"])
      const marker = `"use effect-lsp-patch-version ${installed.version}";`
      let patched = 0
      for (const file of patchedTypeScriptModules) {
        const occurrences = (yield* fs.readFileString(file)).split(marker).length - 1
        expect(occurrences, file).toBe(1)
        patched += occurrences
      }
      expect(patched).toBe(2)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.live("covers every tracked TypeScript source with the workspace project", () =>
    Effect.gen(function*() {
      const tracked = yield* trackedTypeScriptFiles
      const resolved = yield* resolvedWorkspaceFiles
      expect(resolved).toEqual(tracked)
    }).pipe(Effect.provide(NodeServices.layer)))
})
