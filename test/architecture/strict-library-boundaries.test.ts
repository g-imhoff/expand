import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, FileSystem, Path, Schema } from "effect"
import * as ts from "typescript"
import { describe, expect } from "vitest"
import { libraryBoundaryFixtures, privateLibraryPathAliases } from "../support/library-boundary-fixtures"

const PackageManifest = Schema.fromJsonString(Schema.Struct({
  name: Schema.optional(Schema.Unknown),
  private: Schema.optional(Schema.Unknown),
  type: Schema.optional(Schema.Unknown),
  exports: Schema.optional(Schema.Unknown)
}))

const TsConfig = Schema.fromJsonString(Schema.Struct({
  compilerOptions: Schema.optional(Schema.Struct({
    paths: Schema.optional(Schema.Record(Schema.String, Schema.Unknown))
  }))
}))

const provideNode = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, never> => effect.pipe(Effect.provide(NodeServices.layer)) as Effect.Effect<A, E, never>

const read = Effect.fn("StrictLibraryBoundaries.read")(function*(relativePath: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  return yield* fs.readFileString(path.resolve(relativePath))
})

const readJson = (relativePath: string) => read(relativePath).pipe(
  Effect.flatMap(Schema.decodeUnknownEffect(PackageManifest))
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

const resolvesInto = Effect.fn("StrictLibraryBoundaries.resolvesInto")(function* (file: string, specifier: string, root: string, path: Path.Path) {
  const normalizedRoot = path.resolve(root)
  const target = specifier.startsWith("file:")
    ? yield* Effect.try({ try: () => new URL(specifier), catch: String }).pipe(Effect.flatMap(path.fromFileUrl))
    : specifier.startsWith("/")
      ? path.resolve(specifier)
      : specifier.startsWith(".")
        ? path.resolve(path.dirname(file), specifier)
        : undefined
  if (target === undefined) return false
  return target === normalizedRoot || target.startsWith(`${normalizedRoot}${path.sep}`)
})

const packageAliasCanMatch = (pattern: string, packageName: string): boolean => {
  const prefix = pattern.split("*")[0] ?? pattern
  return packageName.startsWith(prefix) || prefix === packageName || prefix.startsWith(`${packageName}/`)
}

type ResolverAlias = string | RegExp

const propertyName = (name: ts.PropertyName): string | undefined => ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) ? name.text : undefined

const resolverAliases = (file: string, source: string): ReadonlyArray<ResolverAlias> => {
  const node = sourceFile(file, source)
  const variables = new Map<string, ts.Expression>()
  const aliases: Array<ResolverAlias> = []
  const remember = (current: ts.Node): void => {
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name) && current.initializer !== undefined) variables.set(current.name.text, current.initializer)
    ts.forEachChild(current, remember)
  }
  remember(node)
  const matcher = (expression: ts.Expression): ResolverAlias | undefined => {
    if (ts.isStringLiteral(expression)) return expression.text
    if (!ts.isRegularExpressionLiteral(expression)) return undefined
    const literal = expression.getText(node)
    const separator = literal.lastIndexOf("/")
    return separator <= 0 ? undefined : new RegExp(literal.slice(1, separator), literal.slice(separator + 1))
  }
  const extract = (expression: ts.Expression): void => {
    if (ts.isIdentifier(expression)) {
      const resolved = variables.get(expression.text)
      if (resolved === undefined) aliases.push("*")
      else extract(resolved)
      return
    }
    if (ts.isArrayLiteralExpression(expression)) {
      for (const element of expression.elements) if (ts.isExpression(element)) extract(element)
      return
    }
    if (!ts.isObjectLiteralExpression(expression)) {
      aliases.push("*")
      return
    }
    const find = expression.properties.find((property) => ts.isPropertyAssignment(property) && propertyName(property.name) === "find")
    if (find !== undefined && ts.isPropertyAssignment(find)) {
      aliases.push(matcher(find.initializer) ?? "*")
      return
    }
    for (const property of expression.properties) {
      if (ts.isSpreadAssignment(property)) aliases.push("*")
      else if (ts.isShorthandPropertyAssignment(property)) extract(property.name)
      else if (ts.isPropertyAssignment(property)) aliases.push(propertyName(property.name) ?? "*")
    }
  }
  const visit = (current: ts.Node): void => {
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name) && current.name.text === "alias" && current.initializer !== undefined) extract(current.initializer)
    if (ts.isPropertyAssignment(current) && propertyName(current.name) === "alias") extract(current.initializer)
    if (ts.isShorthandPropertyAssignment(current) && current.name.text === "alias") extract(current.name)
    ts.forEachChild(current, visit)
  }
  visit(node)
  return aliases.filter((value, index) => aliases.findIndex((candidate) => String(candidate) === String(value)) === index)
}

const resolverAliasCanMatch = (alias: ResolverAlias, packageName: string): boolean => {
  if (typeof alias === "string") return packageAliasCanMatch(alias, packageName)
  const words = alias.source.match(/[A-Za-z][A-Za-z0-9_-]*/g) ?? []
  const suffixes = ["contract", "main", "preload", "renderer", "internal", "internal/value", "secret", "x", ...words]
  const candidates = [packageName, ...suffixes.flatMap((suffix) => [`${packageName}/${suffix}`, `${packageName}/x/${suffix}`])]
  return candidates.some((candidate) => {
    alias.lastIndex = 0
    return alias.test(candidate)
  })
}

const hasAnyValueImport = (file: string, source: string, moduleName: string): boolean => {
  for (const statement of sourceFile(file, source).statements) {
    if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference) && ts.isStringLiteral(statement.moduleReference.expression) && statement.moduleReference.expression.text === moduleName) return true
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== moduleName) continue
    const clause = statement.importClause
    if (clause === undefined) return true
    if (clause.isTypeOnly) continue
    if (clause.name !== undefined || clause.namedBindings === undefined || ts.isNamespaceImport(clause.namedBindings)) return true
    if (clause.namedBindings.elements.some((element) => !element.isTypeOnly)) return true
  }
  return importedSpecifiers(file, source).some((specifier) => specifier === moduleName) && /(?:require(?:\.resolve)?|import)\s*\(/.test(source)
}

const reducerBoundaryViolations = (file: string, source: string): ReadonlyArray<string> => {
  const node = sourceFile(file, source)
  const violations: Array<string> = []
  const visit = (current: ts.Node): void => {
    if (ts.isPropertyAccessExpression(current) && ["key", "input", "event"].includes(current.name.text)) violations.push(current.name.text)
    if (ts.isElementAccessExpression(current) && ts.isStringLiteral(current.argumentExpression) && ["key", "input", "event"].includes(current.argumentExpression.text)) violations.push(current.argumentExpression.text)
    if (ts.isBindingElement(current) && ts.isIdentifier(current.name)) {
      const property = current.propertyName
      const name = property !== undefined && (ts.isIdentifier(property) || ts.isStringLiteral(property)) ? property.text : current.name.text
      if (["key", "input", "event"].includes(name)) violations.push(name)
    }
    ts.forEachChild(current, visit)
  }
  visit(node)
  if (hasAnyValueImport(file, source, "@expand/tui/input/text-field")) violations.push("editor-import")
  return violations
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

  it("recognizes broad and nested aliases that can shadow private packages", () => {
    for (const pattern of ["@expand/*", "@expand/electron-ipc", "@expand/electron-ipc/*", "@expand/electron-ipc/internal/*"]) {
      expect(packageAliasCanMatch(pattern, "@expand/electron-ipc"), pattern).toBe(true)
    }
    expect(packageAliasCanMatch("@expand/cli/*", "@expand/electron-ipc")).toBe(false)
    expect(packageAliasCanMatch("@expand/tui/*", "@expand/ink-input")).toBe(false)
    const fixture = 'export default { resolve: { alias: [{ find: /^@expand\\/electron-ipc\\/secret$/, replacement: "/tmp/private" }] } }'
    expect(resolverAliases("fixture.ts", fixture).some((alias) => resolverAliasCanMatch(alias, "@expand/electron-ipc"))).toBe(true)
  })

  it.live("recognizes relative, absolute, and file URL imports into private package files", () => provideNode(Effect.gen(function* () {
    const path = yield* Path.Path
    const target = path.resolve("packages/electron-ipc/internal/contract.ts")
    const targetUrl = yield* path.toFileUrl(target)
    expect(yield* resolvesInto("scripts/check.ts", "../packages/electron-ipc/internal/contract.ts", "packages/electron-ipc", path)).toBe(true)
    expect(yield* resolvesInto("scripts/check.ts", target, "packages/electron-ipc", path)).toBe(true)
    expect(yield* resolvesInto("scripts/check.ts", targetUrl.href, "packages/electron-ipc", path)).toBe(true)
    expect(yield* resolvesInto("scripts/check.ts", "../packages/contracts/endpoint.ts", "packages/electron-ipc", path)).toBe(false)
  })))

  it("recognizes namespace editor imports and destructured or element key access", () => {
    const fixture = [
      'import * as editor from "@expand/tui/input/text-field"',
      "const reduce = (event: { key: string; input: string }) => {",
      "  const { key } = event",
      '  return [key, event["input"], editor.editTextField] ',
      "}"
    ].join("\n")
    expect(reducerBoundaryViolations("fixture.ts", fixture)).toEqual(expect.arrayContaining(["editor-import", "key", "input"]))
    expect(reducerBoundaryViolations("side-effect.ts", 'import "@expand/tui/input/text-field"')).toContain("editor-import")
  })

  it.live("publishes private package manifests with explicit, non-wildcard export maps", () => provideNode(Effect.gen(function* () {
    for (const fixture of [libraryBoundaryFixtures.electronIpc, libraryBoundaryFixtures.inkInput]) {
      const manifest = yield* readJson(fixture.packagePath)
      expect(manifest.name, fixture.packagePath).toBe(fixture === libraryBoundaryFixtures.electronIpc ? "@expand/electron-ipc" : "@expand/ink-input")
      expect(manifest.private, fixture.packagePath).toBe(true)
      expect(manifest.type, fixture.packagePath).toBe("module")
      expect(manifest.exports, fixture.packagePath).toEqual(fixture.exportMap)
      const exportKeys = Object.keys(manifest.exports as object)
      expect(exportKeys.some((key) => key.includes("*")), fixture.packagePath).toBe(false)
      expect(exportKeys.sort()).toEqual(Object.keys(fixture.exportMap).sort())
    }
  })))

  it.live("removes resolver aliases that can shadow either private library", () => provideNode(Effect.gen(function* () {
    const files = yield* readAll(["."])
    for (const [file, source] of files.filter(([file]) => /(?:^|\/)tsconfig(?:\.[^/]*)?\.json$/.test(file))) {
      const paths = (yield* Schema.decodeUnknownEffect(TsConfig)(source)).compilerOptions?.paths ?? {}
      for (const pattern of Object.keys(paths)) {
        for (const packageName of privateLibraryPathAliases) expect(packageAliasCanMatch(pattern, packageName), `${file} alias ${pattern} shadows ${packageName}`).toBe(false)
      }
    }
    for (const [file, source] of files.filter(([file]) => /(?:vite|vitest)(?:\.[^/]*)?\.config\.[cm]?[jt]s$/.test(file))) {
      for (const alias of resolverAliases(file, source)) {
        for (const packageName of privateLibraryPathAliases) expect(resolverAliasCanMatch(alias, packageName), `${file} alias ${String(alias)} shadows ${packageName}`).toBe(false)
      }
    }
  })))

  for (const entry of Object.values(libraryBoundaryFixtures.electronIpc.publicEntries)) {
    it.live(`exposes only the accepted runtime names from ${entry.specifier}`, () => provideNode(Effect.gen(function* () {
      const module = yield* Effect.tryPromise({ try: () => import(entry.specifier), catch: String })
      expect(Object.keys(module).sort(), entry.specifier).toEqual([...entry.runtimeExports].sort())
    })))
  }

  const inkEntry = libraryBoundaryFixtures.inkInput.publicEntries.root
  it.live(`exposes only the accepted runtime names from ${inkEntry.specifier}`, () => provideNode(Effect.gen(function* () {
    const module = yield* Effect.tryPromise({ try: () => import(inkEntry.specifier), catch: String })
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
    const path = yield* Path.Path
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
      for (const specifier of importedSpecifiers(file, source)) {
        const packageImport = specifier.startsWith("@expand/electron-ipc") || specifier.startsWith("@expand/ink-input")
        const electronPathImport = yield* resolvesInto(normalizedFile, specifier, "packages/electron-ipc", path)
        const inkPathImport = yield* resolvesInto(normalizedFile, specifier, "packages/ink-input", path)
        const pathImport = electronPathImport || inkPathImport
        if (!packageImport && !pathImport) continue
        const allowed = !pathImport && (specifier === "@expand/ink-input" || allowedElectron.has(specifier))
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
    expect(reducerBoundaryViolations("apps/tui/input/reduce.ts", reducer)).toEqual([])
  })))
})
