import { readFile, readdir } from "node:fs/promises"
import { resolve } from "node:path"
import * as ts from "typescript"
import { describe, expect, it } from "vitest"
import { libraryBoundaryFixtures, privateLibraryPathAliases } from "../support/library-boundary-fixtures"

type PackageManifest = {
  readonly name?: unknown
  readonly private?: unknown
  readonly type?: unknown
  readonly exports?: unknown
}

const readJson = async (relativePath: string): Promise<PackageManifest> =>
  JSON.parse(await readFile(resolve(relativePath), "utf8")) as PackageManifest

const readSourceFiles = async (root: string): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(resolve(root), { withFileTypes: true })
  const files: Array<string> = []
  for (const entry of entries) {
    if ([".git", ".worktrees", "worktrees", "external-worktrees", "node_modules", "dist", "out", "build", "coverage", "test-results", ".turbo", ".cache"].includes(entry.name)) continue
    const relative = `${root}/${entry.name}`
    if (entry.isDirectory()) files.push(...await readSourceFiles(relative))
    else if (/\.(?:cjs|js|jsx|json|ts|tsx|mts|cts|mjs)$/.test(entry.name)) files.push(relative)
  }
  return files
}

const readAll = async (roots: ReadonlyArray<string>): Promise<ReadonlyArray<readonly [string, string]>> =>
  (await Promise.all(roots.map(async (root) =>
    Promise.all((await readSourceFiles(root)).map(async (file) => [file, await readFile(resolve(file), "utf8")] as const))
  ))).flat()

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
  const absolute = resolve(file)
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
  const visit = (node: ts.Node): void => {
    if (ts.isExportDeclaration(node) && (node.exportClause === undefined || ts.isNamespaceExport(node.exportClause))) {
      bypasses.push(node.getText(sourceFile))
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return bypasses
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

  it("publishes private package manifests with explicit, non-wildcard export maps", async () => {
    for (const fixture of [libraryBoundaryFixtures.electronIpc, libraryBoundaryFixtures.inkInput]) {
      const manifest = await readJson(fixture.packagePath)
      expect(manifest.name, fixture.packagePath).toBe(
        fixture === libraryBoundaryFixtures.electronIpc ? "@expand/electron-ipc" : "@expand/ink-input"
      )
      expect(manifest.private, fixture.packagePath).toBe(true)
      expect(manifest.type, fixture.packagePath).toBe("module")
      expect(manifest.exports, fixture.packagePath).toEqual(fixture.exportMap)
      const exportKeys = Object.keys(manifest.exports as object)
      expect(exportKeys.some((key) => key.includes("*")), fixture.packagePath).toBe(false)
      expect(exportKeys.sort()).toEqual(Object.keys(fixture.exportMap).sort())
    }
  })

  it("removes wildcard TS aliases for private libraries from every workspace compiler config", async () => {
    const files = await readAll(["."])
    const tsconfigSources = files.filter(([file]) => /(?:^|\/)tsconfig(?:\.[^/]*)?\.json$/.test(file))
    for (const [file, source] of tsconfigSources) {
      const config = JSON.parse(source) as { readonly compilerOptions?: { readonly paths?: Record<string, unknown> } }
      for (const alias of privateLibraryPathAliases) {
        expect(config.compilerOptions?.paths?.[`${alias}/*`], `${file} retains ${alias}/*`).toBeUndefined()
      }
    }
  })

  for (const entry of Object.values(libraryBoundaryFixtures.electronIpc.publicEntries)) {
    it(`exposes only the accepted runtime names from ${entry.specifier}`, async () => {
      const module = await import(entry.specifier)
      expect(Object.keys(module).sort(), entry.specifier).toEqual([...entry.runtimeExports].sort())
    })
  }

  const inkEntry = libraryBoundaryFixtures.inkInput.publicEntries.root
  it(`exposes only the accepted runtime names from ${inkEntry.specifier}`, async () => {
    const module = await import(inkEntry.specifier)
    expect(Object.keys(module).sort(), inkEntry.specifier).toEqual([...inkEntry.runtimeExports].sort())
  })

  it("exposes only the accepted declaration names, including type-only exports", async () => {
    const entrypoints = [
      ["packages/electron-ipc/contract.ts", ["IpcChannel", "IpcContract", "IpcEmitterOf", "IpcHandlersOf"]],
      ["packages/electron-ipc/main.ts", ["bindElectronIpc"]],
      ["packages/electron-ipc/preload.ts", ["exposeElectronBridge"]],
      ["packages/electron-ipc/renderer.ts", ["IpcClientOf", "IpcTransportError", "makeElectronIpcClient"]],
      ["packages/ink-input/index.ts", ["Bindings", "HintBar", "KeyEvent", "defineBindings", "useGlobalKeyRouter"]]
    ] as const
    for (const [file, allowed] of entrypoints) {
      const names = exportedNames(file)
      expect([...new Set(names)].sort(), file).toEqual([...allowed].sort())
    }
  })

  it("does not permit export-star, namespace, or type-star bypasses", async () => {
    for (const file of ["packages/electron-ipc/contract.ts", "packages/electron-ipc/main.ts", "packages/electron-ipc/preload.ts", "packages/electron-ipc/renderer.ts", "packages/ink-input/index.ts"]) {
      const source = await readFile(resolve(file), "utf8")
      expect(exportBypasses(file, source), file).toEqual([])
    }
  })

  it("keeps public function option signatures narrow", async () => {
    const rendererFile = "packages/electron-ipc/renderer.ts"
    const rendererParameters = exportedFunctionParameters(rendererFile, "makeElectronIpcClient")
    expect(rendererParameters).toHaveLength(2)
    expect([...rendererParameters[1]?.properties ?? []].sort()).toEqual(["timeoutMillis"])

    const mainFile = "packages/electron-ipc/main.ts"
    const mainParameters = exportedFunctionParameters(mainFile, "bindElectronIpc")
    expect(mainParameters).toHaveLength(3)
    expect([...mainParameters[2]?.properties ?? []].sort()).toEqual(["maxPayloadBytes", "rendererOrigin", "rendererUrl", "window"])
  })

  it("does not export renderer bridge seams or main host/origin seams", async () => {
    const renderer = await readFile(resolve("packages/electron-ipc/renderer.ts"), "utf8")
    const main = await readFile(resolve("packages/electron-ipc/main.ts"), "utf8")
    expect(renderer).not.toMatch(/export\s+(?:interface|type)\s+(?:MakeIpcClientOptions|RendererWindowLike|MessageEventLike)/)
    expect(main).not.toMatch(/export\s+(?:interface|type)\s+(?:IpcMainLike|WindowTargetLike|OriginRule|FrameLike)/)
    expect(main).not.toMatch(/fileProtocol/)
  })

  it("rejects external deep imports into either private library", async () => {
    const sourceFiles = await readAll(["."])
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
  })

  it("keeps text editing app-owned and centralized in the TUI", async () => {
    const inkFiles = await readSourceFiles("packages/ink-input")
    expect(inkFiles.filter((file) => file.endsWith("/text-field.ts"))).toEqual([])
    const editor = await readFile(resolve("apps/tui/input/text-field.ts"), "utf8")
    const route = await readFile(resolve("apps/tui/input/route.ts"), "utf8")
    const reducer = await readFile(resolve("apps/tui/input/reduce.ts"), "utf8")
    expect(editor).toMatch(/export\s+(?:const|function)\s+editTextField/)
    expect(route).toMatch(/(?:from|import)[^"\n]*text-field/)
    expect(route).toMatch(/editTextField/)
    expect(reducer).not.toMatch(/(?:from|import)[^"\n]*text-field/)
    expect(reducer).not.toMatch(/editTextField|textField(?:Reduce|Consumes)/)
    expect(reducer).not.toMatch(/(?:KeyEvent|\.key|\.input|\.event)/)
  })
})
