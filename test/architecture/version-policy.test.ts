import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { ENVELOPE_VERSION } from "../../apps/cli/cli/contract/envelope"
import {
  EVENT_REVISIONS,
  EVENT_UPCASTERS,
  type EventUpcasterRegistry
} from "../../apps/server/migrations/events"
import { CURRENT_DATABASE_MIGRATION, DATABASE_MIGRATIONS } from "../../apps/server/migrations/sqlite"
import { PROTOCOL_VERSION } from "../../packages/contracts/rpc/version"
import { stage as stageClientPackage } from "../../packages/client-ts/scripts/prepare-publish"
import { stage as stageContractsPackage } from "../../packages/contracts/scripts/prepare-publish"
import { makeElectronConfig } from "../../apps/desktop/electron.vite.config"
import { BUILD_ENTRIES, BuildTool, buildBinaries } from "../../scripts/build"
import { resolveAppVersionObservation } from "../../scripts/app-version"
import { runCommand } from "../support/effect-process"
import { Effect, FileSystem, Layer, Path, Schema } from "effect"
import ts from "typescript"
import { describe, expect } from "vitest"

const manifestPaths = [
  "package.json",
  "apps/desktop/package.json",
  "packages/contracts/package.json",
  "packages/client-ts/package.json",
  "docs/architecture/package.json"
] as const

const documentedDomains = [
  "Product release",
  "Tracked workspace manifests",
  "CLI envelope",
  "Backend protocol",
  "SQLite schema",
  "Stored events",
  "Projection folds",
  "Audit inventories",
  "Benchmark seed cache",
  "Internal Effect commands",
  "Runtime and dependency pins",
  "Codex review model"
] as const

const Manifest = Schema.Struct({
  name: Schema.String,
  version: Schema.optional(Schema.String),
  private: Schema.optional(Schema.Boolean),
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String))
})

const PublishedVersion = Schema.Struct({
  version: Schema.String,
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String))
})

const databaseMigrationIdsAreContiguous = (migrationIds: ReadonlyArray<number>, currentMigration: number) =>
  migrationIds.length === currentMigration &&
  migrationIds.every((id, index) => id === index + 1)

const isPolicySourcePath = (relative: string) =>
  /^(?:apps|packages)\/.+\.(?:ts|tsx)$/.test(relative) &&
  !relative.split("/").some((segment) => ["test", "tests", "e2e", "generated", "__tests__"].includes(segment)) &&
  !/\.(?:test|spec|generated)\.(?:ts|tsx)$/.test(relative)

const selectPolicySources = (
  tracked: ReadonlyArray<string>,
  available: ReadonlyArray<string> = tracked
) => {
  const availableSet = new Set(available)
  return tracked.filter((relative) => availableSet.has(relative) && isPolicySourcePath(relative))
}

const propertyName = (name: ts.PropertyName) => ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined

const visit = (node: ts.Node, use: (node: ts.Node) => void) => {
  use(node)
  ts.forEachChild(node, (child) => visit(child, use))
}

const hasExportModifier = (node: ts.Node) =>
  ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true

const sourceFile = (source: string) => ts.createSourceFile("fixture.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

const exportedConstDefinitions = (source: string, name: string) => {
  let definitions = 0
  for (const statement of sourceFile(source).statements) {
    if (!ts.isVariableStatement(statement) || !hasExportModifier(statement)) continue
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) definitions += 1
    }
  }
  return definitions
}

const unwrapExpression = (expression: ts.Expression): ts.Expression => {
  let current = expression
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) || ts.isTypeAssertionExpression(current)) {
    current = current.expression
  }
  return current
}

const forbiddenGitUses = (source: string) => {
  const parsed = sourceFile(source)
  const findings: Array<string> = []
  const childProcessBindings = new Set<string>()
  const processModuleBindings = new Set<string>()
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const bindings = statement.importClause?.namedBindings
    if (bindings === undefined) continue
    if (statement.moduleSpecifier.text === "effect/unstable/process" && ts.isNamespaceImport(bindings)) {
      processModuleBindings.add(bindings.name.text)
    }
    if (statement.moduleSpecifier.text === "effect/unstable/process/ChildProcess" && ts.isNamespaceImport(bindings)) {
      childProcessBindings.add(bindings.name.text)
    }
    if (statement.moduleSpecifier.text === "effect/unstable/process" && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if ((element.propertyName?.text ?? element.name.text) === "ChildProcess") childProcessBindings.add(element.name.text)
      }
    }
  }
  const isChildProcessBinding = (expression: ts.Expression) => {
    const unwrapped = unwrapExpression(expression)
    if (ts.isIdentifier(unwrapped)) return childProcessBindings.has(unwrapped.text)
    if (!ts.isPropertyAccessExpression(unwrapped) || unwrapped.name.text !== "ChildProcess") return false
    const owner = unwrapExpression(unwrapped.expression)
    return ts.isIdentifier(owner) && processModuleBindings.has(owner.text)
  }
  visit(parsed, (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) &&
      ["child_process", "node:child_process"].includes(node.moduleSpecifier.text)) {
      findings.push(node.moduleSpecifier.text)
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression !== undefined && ts.isStringLiteral(node.moduleReference.expression) &&
      ["child_process", "node:child_process"].includes(node.moduleReference.expression.text)) {
      findings.push(node.moduleReference.expression.text)
    }
    if (ts.isCallExpression(node) && node.arguments[0] !== undefined && ts.isStringLiteral(node.arguments[0]) &&
      ["child_process", "node:child_process"].includes(node.arguments[0].text) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === "require") || node.expression.kind === ts.SyntaxKind.ImportKeyword)) {
      findings.push(node.arguments[0].text)
    }
    if (!ts.isCallExpression(node) || node.arguments.length < 2) return
    const [command, args] = node.arguments
    if (command === undefined || args === undefined || !ts.isStringLiteral(command) || command.text !== "git" || !ts.isArrayLiteralExpression(args)) return
    const subcommand = args.elements[0]
    if (subcommand === undefined || !ts.isStringLiteral(subcommand) || !["describe", "tag", "rev-parse"].includes(subcommand.text)) return
    const callee = unwrapExpression(node.expression)
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === "make" && isChildProcessBinding(callee.expression)) findings.push(`git ${subcommand.text}`)
  })
  return findings
}

const hasForbiddenGitUse = (source: string) => forbiddenGitUses(source).length > 0

const findExportedFunction = (parsed: ts.SourceFile, exportName: string) => {
  for (const statement of parsed.statements) {
    if (ts.isFunctionDeclaration(statement) && hasExportModifier(statement) && statement.name?.text === exportName) return statement
    if (!ts.isVariableStatement(statement) || !hasExportModifier(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== exportName || declaration.initializer === undefined) continue
      let found: ts.FunctionExpression | ts.ArrowFunction | undefined
      visit(declaration.initializer, (node) => {
        if (found === undefined && (ts.isFunctionExpression(node) || ts.isArrowFunction(node))) found = node
      })
      if (found !== undefined) return found
    }
  }
}

const stageUsesReleaseParameter = (parsed: ts.SourceFile, property: string = "version") => {
  const stage = findExportedFunction(parsed, "stage")
  const parameter = stage?.parameters[1]?.name
  if (stage === undefined || parameter === undefined || !ts.isIdentifier(parameter) || stage.body === undefined) return false
  let usesParameter = false
  visit(stage.body, (node) => {
    if (ts.isPropertyAssignment(node) && propertyName(node.name) === property &&
      ts.isIdentifier(node.initializer) && node.initializer.text === parameter.text) usesParameter = true
    if (ts.isShorthandPropertyAssignment(node) && node.name.text === property && node.name.text === parameter.text) usesParameter = true
  })
  return usesParameter
}

const exportedFunctionPassesParameter = (
  parsed: ts.SourceFile,
  exportName: string,
  parameterIndex: number,
  calleeName: string,
  argumentIndex: number
) => {
  const fn = findExportedFunction(parsed, exportName)
  const parameter = fn?.parameters[parameterIndex]?.name
  if (fn === undefined || parameter === undefined || !ts.isIdentifier(parameter) || fn.body === undefined) return false
  const calls: Array<ts.CallExpression> = []
  visit(fn.body, (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === calleeName) calls.push(node)
  })
  return calls.length > 0 && calls.every((call) => {
    const argument = call.arguments[argumentIndex]
    return argument !== undefined && ts.isIdentifier(argument) && argument.text === parameter.text
  })
}

const usesRuntimeIdentifier = (source: string, name: string) => {
  let found = false
  visit(sourceFile(source), (node) => {
    if (ts.isIdentifier(node) && node.text === name) found = true
  })
  return found
}

const atRepositoryRoot = <A, E, R>(use: (root: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    const root = yield* path.fromFileUrl(new URL("../../", import.meta.url))
    return yield* use(root)
  }).pipe(Effect.provide(NodeServices.layer))

describe("version policy", () => {
  it("rejects a database migration gap before the current migration", () => {
    expect(databaseMigrationIdsAreContiguous([1, 3], 3)).toBe(false)
  })

  it("limits policy ownership and runtime scans to tracked non-test sources", () => {
    expect(selectPolicySources(
      [
        "apps/cli/owner.ts",
        "apps/desktop/e2e/release.spec.ts",
        "packages/contracts/generated/schema.ts",
        "packages/contracts/runtime.ts"
      ],
      [
        "apps/cli/owner.ts",
        "apps/cli/untracked.ts",
        "apps/desktop/e2e/release.spec.ts",
        "packages/contracts/generated/schema.ts",
        "packages/contracts/runtime.ts"
      ]
    )).toEqual(["apps/cli/owner.ts", "packages/contracts/runtime.ts"])
    expect(exportedConstDefinitions('export { ENVELOPE_VERSION } from "./owner"', "ENVELOPE_VERSION")).toBe(0)
  })

  it("counts only immutable exported ownership declarations", () => {
    expect(exportedConstDefinitions("export const PROTOCOL_VERSION = 2", "PROTOCOL_VERSION")).toBe(1)
    expect(exportedConstDefinitions('export { PROTOCOL_VERSION } from "./owner"', "PROTOCOL_VERSION")).toBe(0)
    expect(exportedConstDefinitions("export let PROTOCOL_VERSION = 2", "PROTOCOL_VERSION")).toBe(0)
    expect(exportedConstDefinitions("export var PROTOCOL_VERSION = 2", "PROTOCOL_VERSION")).toBe(0)
  })

  it("detects parenthesized executable structured Git calls", () => {
    expect(hasForbiddenGitUse('import { ChildProcess } from "effect/unstable/process"\nChildProcess.make("git", ["describe", "--tags"])')).toBe(true)
    expect(hasForbiddenGitUse('import { ChildProcess } from "effect/unstable/process"\n(ChildProcess).make("git", ["describe", "--tags"])')).toBe(true)
  })

  it("resolves aliased Effect ChildProcess imports", () => {
    expect(hasForbiddenGitUse('import { ChildProcess as Process } from "effect/unstable/process"\nProcess.make("git", ["describe", "--tags"])')).toBe(true)
    expect(hasForbiddenGitUse('import * as Process from "effect/unstable/process/ChildProcess"\nProcess.make("git", ["describe", "--tags"])')).toBe(true)
    expect(hasForbiddenGitUse('const ChildProcess = { make: () => undefined }\nChildProcess.make("git", ["describe"])')).toBe(false)
  })

  it("ignores forbidden Git text in comments and strings", () => {
    expect(hasForbiddenGitUse('const example = "git describe"\n// node:child_process')).toBe(false)
  })

  it("recognizes staged release flow independently of parameter names and formatting", () => {
    const fixture = sourceFile(`
      export const stage = Effect.fn("stage")(function* (directory: string, version: string) {
        const manifest = {
          version
        }
        return manifest
      })
    `)
    expect(stageUsesReleaseParameter(fixture)).toBe(true)
  })

  it.live("keeps compatibility literals under one approved owner", () =>
    atRepositoryRoot((root) => Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      expect(ENVELOPE_VERSION).toBe("expand/v1")
      expect(PROTOCOL_VERSION).toBe(2)
      expect(EVENT_REVISIONS.ProjectCreated).toBe(2)
      expect(CURRENT_DATABASE_MIGRATION).toBe(1)

      const definitions = {
        ENVELOPE_VERSION: [] as Array<string>,
        PROTOCOL_VERSION: [] as Array<string>
      }
      const tracked = yield* runCommand("git", ["ls-files", "-z", "--", "apps", "packages"], { cwd: root })
      expect(tracked.exitCode).toBe(0)
      for (const relative of selectPolicySources(tracked.stdout.split("\0").filter(Boolean))) {
        const source = yield* fs.readFileString(`${root}/${relative}`)
        for (const name of Object.keys(definitions) as Array<keyof typeof definitions>) {
          definitions[name].push(...Array.from({ length: exportedConstDefinitions(source, name) }, () => relative))
        }
      }

      expect(definitions.ENVELOPE_VERSION).toEqual(["apps/cli/cli/contract/envelope.ts"])
      expect(definitions.PROTOCOL_VERSION).toEqual(["packages/contracts/rpc/version.ts"])
    })))

  it.effect("keeps migration chains contiguous and release observations deterministic", () =>
    Effect.gen(function*() {
      const upcasters: EventUpcasterRegistry = EVENT_UPCASTERS
      for (const [tag, currentRevision] of Object.entries(EVENT_REVISIONS)) {
        for (let revision = 1; revision < currentRevision; revision += 1) {
          expect(upcasters[tag]?.[revision], `${tag} revision ${revision}`).toBeTypeOf("function")
        }
      }

      const migrationIds = Object.keys(DATABASE_MIGRATIONS).map((key) => {
        expect(key).toMatch(/^\d+_/)
        return Number.parseInt(key, 10)
      })
      expect(databaseMigrationIdsAreContiguous(migrationIds, CURRENT_DATABASE_MIGRATION)).toBe(true)

      expect(yield* resolveAppVersionObservation({ exactTags: ["v1.2.3"], shortSha: undefined }, "release")).toBe("1.2.3")
      expect(yield* resolveAppVersionObservation({ exactTags: [], shortSha: "0123456789ab" }, "development")).toBe("0.0.0-dev+0123456789ab")
      const malformed = yield* resolveAppVersionObservation({ exactTags: ["v01.2.3"], shortSha: undefined }, "release").pipe(Effect.flip)
      expect(malformed.reason).toBe("invalid-release-tag")
      const conflicting = yield* resolveAppVersionObservation({ exactTags: ["v1.2.3", "v2.0.0"], shortSha: undefined }, "release").pipe(Effect.flip)
      expect(conflicting.reason).toBe("conflicting-release-tags")
    }))

  it.live("keeps one artifact identity flowing through build and staging", () =>
    atRepositoryRoot((root) => Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const read = (relative: string) => fs.readFileString(path.join(root, relative))
      const contractsStage = yield* read("packages/contracts/scripts/prepare-publish.ts")
      const clientStage = yield* read("packages/client-ts/scripts/prepare-publish.ts")
      const buildInfo = yield* read("packages/contracts/build-info.ts")
      const desktopCommandSource = sourceFile(yield* read("scripts/desktop-command.ts"))

      expect(BUILD_ENTRIES).toHaveLength(2)
      const binaryDefinitions: Array<unknown> = []
      yield* buildBinaries("/repo", "9.8.7").pipe(
        Effect.provideService(BuildTool, {
          build: (options) => Effect.sync(() => binaryDefinitions.push(options.define))
        }),
        Effect.provide(Layer.mergeAll(FileSystem.layerNoop({
          remove: () => Effect.void,
          makeDirectory: () => Effect.void,
          chmod: () => Effect.void
        }), Path.layer))
      )
      expect(binaryDefinitions).toEqual([
        { __EXPAND_CHANNEL__: '"release"', __EXPAND_VERSION__: '"9.8.7"' },
        { __EXPAND_CHANNEL__: '"release"', __EXPAND_VERSION__: '"9.8.7"' }
      ])
      const desktopConfig = makeElectronConfig("9.8.7")
      expect([desktopConfig.main?.define, desktopConfig.preload?.define, desktopConfig.renderer?.define]).toEqual([
        { __EXPAND_VERSION__: '"9.8.7"' },
        { __EXPAND_VERSION__: '"9.8.7"' },
        { __EXPAND_VERSION__: '"9.8.7"' }
      ])
      expect(usesRuntimeIdentifier(buildInfo, "__EXPAND_VERSION__")).toBe(true)
      expect(stageUsesReleaseParameter(sourceFile(contractsStage))).toBe(true)
      expect(stageUsesReleaseParameter(sourceFile(clientStage))).toBe(true)
      expect(stageUsesReleaseParameter(sourceFile(clientStage), "@expand/contracts")).toBe(true)
      expect(exportedFunctionPassesParameter(desktopCommandSource, "runDesktopCommand", 2, "runCommand", 3)).toBe(true)

      for (const [relative, stage] of [
        ["packages/contracts", stageContractsPackage],
        ["packages/client-ts", stageClientPackage]
      ] as const) {
        const fixture = yield* fs.makeTempDirectoryScoped({ prefix: "expand-version-policy-" })
        yield* fs.writeFileString(path.join(fixture, "package.json"), yield* read(`${relative}/package.json`))
        yield* fs.makeDirectory(path.join(fixture, "dist"))
        yield* stage(fixture, "9.8.7")
        const published = yield* fs.readFileString(path.join(fixture, "dist-publish", "package.json")).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(PublishedVersion)))
        )
        expect(published.version).toBe("9.8.7")
        if (relative === "packages/client-ts") expect(published.dependencies?.["@expand/contracts"]).toBe("9.8.7")
      }

      const tracked = yield* runCommand("git", ["ls-files", "-z", "--", "apps", "packages"], { cwd: root })
      expect(tracked.exitCode).toBe(0)
      for (const relative of selectPolicySources(tracked.stdout.split("\0").filter(Boolean))) {
        expect(forbiddenGitUses(yield* fs.readFileString(path.join(root, relative))), relative).toEqual([])
      }
    }).pipe(Effect.scoped)))

  it.live("keeps tracked manifests as sentinels and documents every version domain", () =>
    atRepositoryRoot((root) => Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const manifests = new Map<string, typeof Manifest.Type>()
      for (const relative of manifestPaths) {
        const manifest = yield* fs.readFileString(path.join(root, relative)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest)))
        )
        manifests.set(relative, manifest)
        if (manifest.private === true && manifest.version !== undefined) {
          expect(manifest.version, relative).toBe("0.0.0")
        }
      }

      const contracts = manifests.get("packages/contracts/package.json")
      const client = manifests.get("packages/client-ts/package.json")
      expect(contracts?.version).toBe("0.0.0")
      expect(client?.version).toBe("0.0.0")
      expect(client?.dependencies?.["@expand/contracts"]).toBe(contracts?.version)

      const documentation = yield* fs.readFileString(path.join(root, "docs/architecture/VERSIONING.md"))
      for (const domain of documentedDomains) {
        const occurrences = documentation.split("\n").filter((line) => line === `## ${domain}`).length
        expect(occurrences, domain).toBe(1)
      }
      expect(documentation).toContain("v<SemVer>")
      expect(documentation).toContain("expand/v1")
      expect(documentation).toContain("gpt-5.6-luna")
      expect(documentation).toContain("`max`")
    })))
})
