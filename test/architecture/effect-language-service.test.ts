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
  diagnosticSeverity: Schema.optionalKey(StringMap)
})
const RootConfigJson = Schema.fromJsonString(Schema.Struct({
  compilerOptions: Schema.Struct({ plugins: Schema.Array(PluginJson) })
}))
const AuditConfigJson = Schema.fromJsonString(Schema.Struct({
  extends: Schema.String,
  include: Schema.Array(Schema.String),
  exclude: Schema.Array(Schema.String)
}))
const DesktopConfigJson = Schema.fromJsonString(Schema.Struct({
  extends: Schema.String,
  exclude: Schema.Array(Schema.String),
  include: Schema.Array(Schema.String)
}))

const readJson = Effect.fn("EffectAuditTest.readJson")(
  function* <S extends Schema.Top>(file: string, schema: S) {
    const fs = yield* FileSystem.FileSystem
    return yield* Schema.decodeUnknownEffect(schema)(yield* fs.readFileString(file))
  }
)

const isTypeScriptFile = (file: string) =>
  file.endsWith(".ts") || file.endsWith(".tsx") || file.endsWith(".mts") || file.endsWith(".cts")

const normalizedRepositoryFiles = Effect.fn("EffectAuditTest.normalizedRepositoryFiles")(
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
    return yield* normalizedRepositoryFiles(report.stdout.split("\0").filter(isTypeScriptFile))
})

const resolvedAuditFiles = Effect.gen(function*() {
    const report = yield* runCommand("npm", [
      "exec",
      "--",
      "tsc",
      "--listFilesOnly",
      "-p",
      "tsconfig.effect-audit.json"
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
  "effect:diagnostics": "effect-language-service diagnostics --project tsconfig.effect-audit.json --format json --severity error,warning,message",
  "effect:diagnostics:root": "effect-language-service diagnostics --project tsconfig.json --format json --severity error,warning,message",
  "effect:diagnostics:desktop": "effect-language-service diagnostics --project apps/desktop/tsconfig.json --format json --severity error,warning,message",
  "typecheck:effect-audit": "tsc --noEmit -p tsconfig.effect-audit.json"
}

const expectedDiagnosticSeverity = {
  asyncFunction: "error",
  newPromise: "error",
  nodeBuiltinImport: "error",
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
  processEnv: "error",
  processEnvInEffect: "error",
  preferSchemaOverJson: "error",
  floatingEffect: "error",
  lazyPromiseInEffectSync: "error",
  runEffectInsideEffect: "error",
  tryCatchInEffectGen: "error",
  globalErrorInEffectCatch: "error",
  globalErrorInEffectFailure: "error",
  effectFnOpportunity: "message"
}

const expectedAuditIncludes = [
  "apps",
  "packages",
  "scripts",
  "examples",
  "bench",
  "migrations",
  "test",
  "eslint-rules",
  "docs/architecture",
  "*.ts",
  "*.tsx",
  "*.mts",
  "*.cts"
]

const expectedAuditExcludes = [
  "**/node_modules/**",
  "**/dist/**",
  "**/out/**",
  "**/build/**",
  "**/coverage/**",
  "**/test-results/**",
  "**/playwright-report/**"
]

describe("Effect language service diagnostics", () => {
  it.live("pins the official packages, scripts, plugin, and audit project", () =>
    Effect.gen(function*() {
      const packageJson = yield* readJson("package.json", PackageJson)
      const rootConfig = yield* readJson("tsconfig.json", RootConfigJson)
      const auditConfig = yield* readJson("tsconfig.effect-audit.json", AuditConfigJson)
      const desktopConfig = yield* readJson("apps/desktop/tsconfig.json", DesktopConfigJson)

      expect(packageJson.devDependencies["@effect/language-service"]).toBe("0.86.6")
      expect(packageJson.devDependencies["@effect/vitest"]).toBe("4.0.0-beta.74")
      expect(packageJson.scripts).toMatchObject(expectedScripts)
      expect(rootConfig.compilerOptions.plugins).toEqual([{
        name: "@effect/language-service",
        diagnosticSeverity: expectedDiagnosticSeverity
      }])
      expect(rootConfig.compilerOptions.plugins.at(-1)?.diagnosticSeverity).not.toHaveProperty(
        "schemaSyncInEffect"
      )
      expect(auditConfig).toEqual({
        extends: "./tsconfig.json",
        include: expectedAuditIncludes,
        exclude: expectedAuditExcludes
      })
      expect(desktopConfig).toEqual({
        extends: "../../tsconfig.json",
        exclude: [],
        include: [
          "src",
          "test/integration",
          "test/ui",
          "test/unit/*.test.ts",
          "test/unit/*.test.tsx",
          "../../packages/contracts/globals.d.ts"
        ]
      })
    }).pipe(Effect.provide(NodeServices.layer)))

  it.live("covers every tracked TypeScript source with the Effect audit project", () =>
    Effect.gen(function*() {
      const tracked = yield* trackedTypeScriptFiles
      const resolved = yield* resolvedAuditFiles
      expect(resolved).toEqual(tracked)
    }).pipe(Effect.provide(NodeServices.layer)))
})
