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

const resolvedWorkspaceFiles = Effect.gen(function*() {
    const report = yield* runCommand("npm", [
      "exec",
      "--",
      "tsc",
      "--listFilesOnly",
      "-p",
      "tsconfig.workspace.json"
    ])
    expect(report.exitCode, report.stderr).toBe(0)
    const path = yield* Path.Path
    const root = path.resolve(".")
    const files = report.stdout.split(/\r?\n/).filter((file) => {
      if (!isTypeScriptFile(file)) return false
      const relative = path.relative(root, path.resolve(file))
      return relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !relative.split(path.sep).includes("node_modules")
    })
    return yield* normalizedRepositoryFiles(files)
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
      expect(packageJson.devDependencies["@effect/vitest"]).toBe("4.0.0-beta.74")
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
      const check = yield* runCommand("npm", ["exec", "--", "effect-language-service", "check"])
      expect(check.exitCode, check.stderr).toBe(0)
      expect(check.stdout.match(/patched with version/g)).toHaveLength(2)
      const typecheck = yield* runCommand("npm", ["run", "typecheck"])
      expect(typecheck.exitCode, `${typecheck.stdout}\n${typecheck.stderr}`).toBe(0)
    }).pipe(Effect.provide(NodeServices.layer)), 120_000)

  it.live("covers every tracked TypeScript source with the workspace project", () =>
    Effect.gen(function*() {
      const tracked = yield* trackedTypeScriptFiles
      const resolved = yield* resolvedWorkspaceFiles
      expect(resolved).toEqual(tracked)
    }).pipe(Effect.provide(NodeServices.layer)))
})
