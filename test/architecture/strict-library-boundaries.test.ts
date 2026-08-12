import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, FileSystem, Path } from "effect"
import * as ts from "typescript"
import { describe, expect } from "vitest"
import { libraryBoundaryFixtures, privateLibraryPathAliases } from "../support/library-boundary-fixtures"

type PackageManifest = {
  readonly name?: unknown
  readonly private?: unknown
  readonly type?: unknown
  readonly exports?: unknown
}

const provideNode = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, never> => effect.pipe(Effect.provide(NodeServices.layer)) as Effect.Effect<A, E, never>

const read = Effect.fn("StrictLibraryBoundaries.read")(function*(relativePath: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  return yield* fs.readFileString(path.resolve(relativePath))
})

const readJson = <A,>(relativePath: string): Effect.Effect<A, unknown, FileSystem.FileSystem | Path.Path> => read(relativePath).pipe(
  Effect.flatMap((source) => Effect.try({ try: () => JSON.parse(source) as A, catch: (cause) => cause }))
)

const readSourceFiles = Effect.fn("StrictLibraryBoundaries.readSourceFiles")(function*(root: string): Effect.fn.Return<ReadonlyArray<string>, unknown, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const entries = yield* fs.readDirectory(path.resolve(root))
  const files: Array<string> = []
  for (const entry of entries) {
    if ([".git", ".worktrees", "worktrees", "external-worktrees", "node_modules", "dist", "out", "build", "coverage", "test-results", ".turbo", ".cache"].includes(entry)) continue
    const relative = path.join(root, entry)
    const absolute = path.resolve(relative)
    const info = yield* fs.stat(absolute)
    if (info.type === "Directory") files.push(...yield* readSourceFiles(relative))
    else if (/\.(?:cjs|js|jsx|json|ts|tsx|mts|cts|mjs)$/.test(entry)) files.push(relative)
  }
  return files
})

const readAll = Effect.fn("StrictLibraryBoundaries.readAll")(function*(roots: ReadonlyArray<string>): Effect.fn.Return<ReadonlyArray<readonly [string, string]>, unknown, FileSystem.FileSystem | Path.Path> {
  const all: Array<readonly [string, string]> = []
  for (const root of roots) {
    for (const file of yield* readSourceFiles(root)) all.push([file, yield* read(file)])
  }
  return all
})

const importedSpecifiers = (file: string, source: string): ReadonlyArray<string> => {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const specifiers: Array<string> = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text)
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
      specifiers.push(node.moduleReference.expression.text)
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text)
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require") || (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "require" && node.expression.name.text === "resolve"))) {
      const argument = node.arguments[0]
      if (argument !== undefined && ts.isStringLiteral(argument)) specifiers.push(argument.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return specifiers
}

const makeChecker = (file: string): { readonly sourceFile: ts.SourceFile; readonly checker: ts.TypeChecker } => {
  const absolute = ts.sys.resolvePath(file)
  const program = ts.createProgram([absolute], {
    allowJs: true,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022
  })
  const sourceFile = program.getSourceFile(absolute)
  if (sourceFile === undefined) throw new Error(`missing source file: ${file}`)
  return { sourceFile, checker: program.getTypeChecker() }
}

const checkerModule = (file: string): { readonly sourceFile: ts.SourceFile; readonly checker: ts.TypeChecker; readonly module: ts.Symbol } => {
  const checked = makeChecker(file)
  const module = checked.checker.getSymbolAtLocation(checked.sourceFile)
  if (module === undefined) throw new Error(`missing module symbol: ${file}`)
  return { ...checked, module }
}

const exportedNames = (file: string): ReadonlyArray<string> => {
  const { checker, module } = checkerModule(file)
  return checker.getExportsOfModule(module).map((symbol) => symbol.name)
}

type CheckedParameter = {
  readonly name: string
  readonly properties: ReadonlyArray<string>
}

const exportedFunctionParameters = (file: string, name: string): ReadonlyArray<CheckedParameter> => {
  const { sourceFile, checker, module } = checkerModule(file)
  const symbol = checker.getExportsOfModule(module).find((candidate) => candidate.name === name)
  if (symbol === undefined) return []
  const type = checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration ?? sourceFile)
  const signature = type.getCallSignatures()[0]
  if (signature === undefined) return []
  const firstParameter = signature.parameters[0]
  const tupleParameter = firstParameter !== undefined && signature.parameters.length === 1
    ? checker.getTypeOfSymbolAtLocation(firstParameter, sourceFile)
    : undefined
  if (tupleParameter !== undefined && checker.isTupleType(tupleParameter)) {
    const labels = (tupleParameter as ts.TupleTypeReference).target.labeledElementDeclarations ?? []
    return labels.flatMap((label) => {
      if (label === undefined) return []
      const parameterType = checker.getNonNullableType(checker.getTypeAtLocation(label))
      return [{ name: label.name.getText(sourceFile), properties: parameterType.getProperties().map((property) => property.name) }]
    })
  }
  return signature.parameters.map((parameter) => {
    const parameterType = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(parameter, sourceFile))
    return { name: parameter.name, properties: parameterType.getProperties().map((property) => property.name) }
  })
}

const exportBypasses = (file: string, source: string): ReadonlyArray<string> => {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const bypasses: Array<string> = []
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement) && (statement.exportClause === undefined || ts.isNamespaceExport(statement.exportClause))) bypasses.push(statement.getText(sourceFile))
  }
  return bypasses
}

const sourceFile = (file: string, source: string): ts.SourceFile => ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)

const hasValueImport = (file: string, source: string, moduleName: string, importedName: string): boolean => {
  for (const statement of sourceFile(file, source).statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== moduleName) continue
    const clause = statement.importClause
    if (clause === undefined || clause.isTypeOnly) continue
    if (clause.name?.text === importedName) return true
    if (clause.namedBindings === undefined || !ts.isNamedImports(clause.namedBindings)) continue
    if (clause.namedBindings.elements.some((element) => !element.isTypeOnly && (element.propertyName?.text ?? element.name.text) === importedName)) return true
  }
  return false
}

const hasValueCall = (file: string, source: string, name: string): boolean => {
  let found = false
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) found = true
    ts.forEachChild(node, visit)
  }
  visit(sourceFile(file, source))
  return found
}

const hasExportedDeclaration = (file: string, source: string, name: string): boolean => {
  const fileNode = sourceFile(file, source)
  return fileNode.statements.some((statement) => {
    if (!ts.isVariableStatement(statement) && !ts.isFunctionDeclaration(statement)) return false
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined
    if (!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return false
    if (ts.isFunctionDeclaration(statement)) return statement.name?.text === name
    return statement.declarationList.declarations.some((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name)
  })
}

describe("strict private library boundaries", () => {
  it("scans side-effect, static, export-from, and dynamic import forms", () => {
    const fixture = [
      'import "@expand/electron-ipc/main-electron"',
      'import type { FrameLike } from "@expand/electron-ipc/main"',
      'export { exposeBridge } from "@expand/electron-ipc/preload"',
      'const module = import("@expand/ink-input/text-field")',
      'const required = require("@expand/electron-ipc/renderer")',
      'require.resolve("@expand/ink-input/key-name")',
      'import legacy = require("@expand/electron-ipc/contract")'
    ].join("\n")
    expect(importedSpecifiers("fixture.ts", fixture)).toEqual([
      "@expand/electron-ipc/main-electron",
      "@expand/electron-ipc/main",
      "@expand/electron-ipc/preload",
      "@expand/ink-input/text-field",
      "@expand/electron-ipc/renderer",
      "@expand/ink-input/key-name",
      "@expand/electron-ipc/contract"
    ])
  })

  it.live("publishes private package manifests with explicit, non-wildcard export maps", () => provideNode(Effect.gen(function* () {
    for (const fixture of [libraryBoundaryFixtures.electronIpc, libraryBoundaryFixtures.inkInput]) {
      const manifest = yield* readJson<PackageManifest>(fixture.packagePath)
      expect(manifest.name, fixture.packagePath).toBe(fixture === libraryBoundaryFixtures.electronIpc ? "@expand/electron-ipc" : "@expand/ink-input")
      expect(manifest.private, fixture.packagePath).toBe(true)
      expect(manifest.type, fixture.packagePath).toBe("module")
      expect(manifest.exports, fixture.packagePath).toEqual(fixture.exportMap)
      const exportKeys = Object.keys(manifest.exports as object)
      expect(exportKeys.some((key) => key.includes("*")), fixture.packagePath).toBe(false)
      expect(exportKeys.sort()).toEqual(Object.keys(fixture.exportMap).sort())
    }
  })))

  it.live("removes wildcard TS aliases for private libraries from every workspace compiler config", () => provideNode(Effect.gen(function* () {
    const files = yield* readAll(["."])
    const tsconfigSources = files.filter(([file]) => /(?:^|\/)tsconfig(?:\.[^/]*)?\.json$/.test(file))
    for (const [file, source] of tsconfigSources) {
      const config = JSON.parse(source) as { readonly compilerOptions?: { readonly paths?: Record<string, unknown> } }
      for (const alias of privateLibraryPathAliases) expect(config.compilerOptions?.paths?.[`${alias}/*`], `${file} retains ${alias}/*`).toBeUndefined()
    }
  })))

  for (const entry of Object.values(libraryBoundaryFixtures.electronIpc.publicEntries)) {
    it.live(`exposes only the accepted runtime names from ${entry.specifier}`, () => provideNode(Effect.gen(function* () {
      const module = yield* Effect.tryPromise({ try: () => import(entry.specifier), catch: (cause) => cause })
      expect(Object.keys(module).sort(), entry.specifier).toEqual([...entry.runtimeExports].sort())
    })))
  }

  const inkEntry = libraryBoundaryFixtures.inkInput.publicEntries.root
  it.live(`exposes only the accepted runtime names from ${inkEntry.specifier}`, () => provideNode(Effect.gen(function* () {
    const module = yield* Effect.tryPromise({ try: () => import(inkEntry.specifier), catch: (cause) => cause })
    expect(Object.keys(module).sort(), inkEntry.specifier).toEqual([...inkEntry.runtimeExports].sort())
  })))

  it.live("exposes only the accepted declaration names, including type-only exports", () => provideNode(Effect.gen(function* () {
    const entrypoints = [
      ["packages/electron-ipc/contract.ts", ["IpcChannel", "IpcContract", "IpcEmitterOf", "IpcHandlersOf"]],
      ["packages/electron-ipc/main.ts", ["bindElectronIpc"]],
      ["packages/electron-ipc/preload.ts", ["exposeElectronBridge"]],
      ["packages/electron-ipc/renderer.ts", ["IpcClientOf", "IpcTransportError", "makeElectronIpcClient"]],
      ["packages/ink-input/index.ts", ["Bindings", "HintBar", "KeyEvent", "defineBindings", "useGlobalKeyRouter"]]
    ] as const
    for (const [file, allowed] of entrypoints) expect([...new Set(exportedNames(file))].sort(), file).toEqual([...allowed].sort())
  })))

  it.live("does not permit export-star, namespace, or type-star bypasses", () => provideNode(Effect.gen(function* () {
    for (const file of ["packages/electron-ipc/contract.ts", "packages/electron-ipc/main.ts", "packages/electron-ipc/preload.ts", "packages/electron-ipc/renderer.ts", "packages/ink-input/index.ts"]) {
      const source = yield* read(file)
      expect(exportBypasses(file, source), file).toEqual([])
    }
  })))

  it.live("keeps public function option signatures narrow", () => provideNode(Effect.gen(function* () {
    const rendererParameters = exportedFunctionParameters("packages/electron-ipc/renderer.ts", "makeElectronIpcClient")
    expect(rendererParameters).toHaveLength(2)
    expect([...rendererParameters[1]?.properties ?? []].sort()).toEqual(["timeoutMillis"])
    const mainParameters = exportedFunctionParameters("packages/electron-ipc/main.ts", "bindElectronIpc")
    expect(mainParameters).toHaveLength(3)
    expect([...mainParameters[2]?.properties ?? []].sort()).toEqual(["maxPayloadBytes", "rendererOrigin", "rendererUrl", "window"])
  })))

  it.live("does not export renderer bridge seams or main host/origin seams", () => provideNode(Effect.gen(function* () {
    const renderer = yield* read("packages/electron-ipc/renderer.ts")
    const main = yield* read("packages/electron-ipc/main.ts")
    expect(renderer).not.toMatch(/export\s+(?:interface|type)\s+(?:MakeIpcClientOptions|RendererWindowLike|MessageEventLike)/)
    expect(main).not.toMatch(/export\s+(?:interface|type)\s+(?:IpcMainLike|WindowTargetLike|OriginRule|FrameLike)/)
    expect(main).not.toMatch(/fileProtocol/)
  })))

  it.live("rejects external deep imports into either private library", () => provideNode(Effect.gen(function* () {
    const sourceFiles = yield* readAll(["."])
    const offenders: Array<string> = []
    const allowedElectron = new Set([
      "@expand/electron-ipc/contract",
      "@expand/electron-ipc/main",
      "@expand/electron-ipc/preload",
      "@expand/electron-ipc/renderer"
    ])
    for (const [file, source] of sourceFiles) {
      const normalizedFile = file.replace(/^\.\//, "")
      if (normalizedFile.startsWith("packages/electron-ipc/") || normalizedFile.startsWith("packages/ink-input/")) continue
      for (const specifier of importedSpecifiers(file, source).filter((value) => value.startsWith("@expand/electron-ipc") || value.startsWith("@expand/ink-input"))) {
        const allowed = specifier === "@expand/ink-input" || allowedElectron.has(specifier)
        if (!allowed) offenders.push(`${file}: ${specifier}`)
      }
    }
    expect(offenders).toEqual([])
  })))

  it.live("keeps text editing app-owned and centralized in the TUI", () => provideNode(Effect.gen(function* () {
    const inkFiles = yield* readSourceFiles("packages/ink-input")
    expect(inkFiles.filter((file) => file.endsWith("/text-field.ts"))).toEqual([])
    const editor = yield* read("apps/tui/input/text-field.ts")
    const route = yield* read("apps/tui/input/route.ts")
    const reducer = yield* read("apps/tui/input/reduce.ts")
    expect(hasExportedDeclaration("apps/tui/input/text-field.ts", editor, "editTextField")).toBe(true)
    expect(hasValueImport("apps/tui/input/route.ts", route, "@expand/tui/input/text-field", "editTextField")).toBe(true)
    expect(hasValueCall("apps/tui/input/route.ts", route, "editTextField")).toBe(true)
    expect(hasValueImport("apps/tui/input/reduce.ts", reducer, "@expand/tui/input/text-field", "editTextField")).toBe(false)
    expect(hasValueCall("apps/tui/input/reduce.ts", reducer, "editTextField")).toBe(false)
    expect(hasValueImport("fixture.ts", 'import type { editTextField } from "@expand/tui/input/text-field"', "@expand/tui/input/text-field", "editTextField")).toBe(false)
    const reducerNode = sourceFile("apps/tui/input/reduce.ts", reducer)
    const reinterpretations: string[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && ["key", "input", "event"].includes(node.name.text)) reinterpretations.push(node.name.text)
      ts.forEachChild(node, visit)
    }
    visit(reducerNode)
    expect(reinterpretations).toEqual([])
  })))
})
