import { Crypto, Data, Effect, Encoding, FileSystem, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import * as ts from "typescript"
import { effectHostBoundaries } from "../eslint-rules/effect-host-boundaries.mjs"

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))

export const ExecutableDeclaration = Schema.Struct({
  kind: Schema.String,
  name: Schema.String
})

export const InvocationLink = Schema.Struct({
  file: Schema.String,
  selector: Schema.String,
  occurrence: NonNegativeInt
})

export const HostBoundaryLink = Schema.Struct({
  declaration: ExecutableDeclaration,
  construct: Schema.String,
  occurrence: NonNegativeInt
})

export const ExecutableInventory = Schema.Struct({
  version: Schema.Literal(1),
  entrypoints: Schema.Array(Schema.Struct({
    file: Schema.String,
    declaration: ExecutableDeclaration,
    kind: Schema.Literals([
      "effect-entrypoint",
      "effect-free-transport-shim",
      "registered-host-launcher",
      "registered-host-fixture"
    ]),
    invokedBy: Schema.Array(InvocationLink),
    hostBoundary: Schema.optional(HostBoundaryLink),
    sourceHash: Schema.optional(Sha256)
  }))
})

export const ExecutableInventoryJson = Schema.fromJsonString(ExecutableInventory)

export type ExecutableInventoryValue = typeof ExecutableInventory.Type
export type ExecutableEntrypoint = ExecutableInventoryValue["entrypoints"][number]
export type ExecutableKind = ExecutableEntrypoint["kind"]
export type Invocation = typeof InvocationLink.Type
export type BoundaryLink = typeof HostBoundaryLink.Type

export interface ExecutableObservation {
  readonly file: string
  readonly declaration: typeof ExecutableDeclaration.Type
  readonly kind: ExecutableKind
  readonly invocation: Invocation
  readonly hostBoundary?: BoundaryLink
  readonly sourceHash?: string
}

export class ExecutableInventoryError extends Data.TaggedError("ExecutableInventoryError")<{
  readonly detail: string
  readonly cause?: unknown
}> {}

export interface ExecutableDiscovery {
  readonly observations: ReadonlyArray<ExecutableObservation>
  readonly trackedFiles: ReadonlyArray<string>
  readonly trackedModes: ReadonlyMap<string, string>
  readonly sourceHashes: ReadonlyMap<string, string>
  readonly entrypointCount: number
}

interface ValidationContext {
  readonly trackedFiles: ReadonlyArray<string>
  readonly trackedModes: ReadonlyMap<string, string>
  readonly sourceHashes: ReadonlyMap<string, string>
}

const fail = (detail: string, cause?: unknown) => new ExecutableInventoryError({
  detail,
  ...(cause === undefined ? {} : { cause })
})

const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0

const validPath = (file: string) =>
  file.length > 0
  && !file.startsWith("/")
  && !file.includes("\\")
  && !file.endsWith("/")
  && !/[*?\[\]{}]/.test(file)
  && file.split("/").every((part) => part !== "" && part !== "." && part !== "..")

const declarationKey = (declaration: typeof ExecutableDeclaration.Type) =>
  `${declaration.kind}:${declaration.name}`

const boundaryKey = (boundary: BoundaryLink | undefined) => boundary === undefined
  ? ""
  : `${declarationKey(boundary.declaration)}\u0000${boundary.construct}\u0000${boundary.occurrence}`

const invocationKey = (link: Invocation) =>
  `${link.file}\u0000${link.selector}\u0000${link.occurrence}`

const observationKey = (observation: ExecutableObservation) =>
  `${observation.file}\u0000${invocationKey(observation.invocation)}`

const sameEntrypointIdentity = (entrypoint: ExecutableEntrypoint, observation: ExecutableObservation) =>
  declarationKey(entrypoint.declaration) === declarationKey(observation.declaration)
  && entrypoint.kind === observation.kind
  && boundaryKey(entrypoint.hostBoundary) === boundaryKey(observation.hostBoundary)
  && entrypoint.sourceHash === observation.sourceHash

export const validateExecutableInventoryRecords = Effect.fn("ExecutableInventory.validateRecords")(
  function*(input: unknown, observations: ReadonlyArray<ExecutableObservation>, context: ValidationContext) {
    const inventory = yield* Schema.decodeUnknownEffect(ExecutableInventory)(input).pipe(
      Effect.mapError((cause) => fail(`inventory schema decode failed: ${String(cause)}`, cause))
    )
    const tracked = new Set(context.trackedFiles)
    const files = inventory.entrypoints.map(({ file }) => file)
    if (inventory.entrypoints.some(({ file }) => !validPath(file))) {
      return yield* fail("inventory contains a malformed repository-relative path")
    }
    if (files.some((file) => !tracked.has(file))) {
      return yield* fail("inventory contains an untracked path")
    }
    if (new Set(files).size !== files.length) {
      return yield* fail("inventory contains duplicate entrypoint paths or declarations")
    }
    const sortedFiles = [...files].sort(compareText)
    if (files.some((file, index) => file !== sortedFiles[index])) {
      return yield* fail("inventory entrypoints are not sorted by path")
    }
    const observationKeys = observations.map(observationKey)
    if (new Set(observationKeys).size !== observationKeys.length) {
      return yield* fail("discovery contains duplicate invocation identities")
    }

    const observationsByFile = new Map<string, Array<ExecutableObservation>>()
    for (const observation of observations) {
      const existing = observationsByFile.get(observation.file) ?? []
      existing.push(observation)
      observationsByFile.set(observation.file, existing)
    }
    for (const entrypoint of inventory.entrypoints) {
      const discovered = observationsByFile.get(entrypoint.file)
      if (discovered === undefined || discovered.length === 0) {
        return yield* fail(`inventory entrypoint is not independently discovered: ${entrypoint.file}`)
      }
      if (discovered.some((observation) => !sameEntrypointIdentity(entrypoint, observation))) {
        const first = discovered[0]!
        if (declarationKey(entrypoint.declaration) !== declarationKey(first.declaration)) {
          return yield* fail(`declaration drift: ${entrypoint.file}`)
        }
        if (entrypoint.kind !== first.kind) return yield* fail(`kind drift: ${entrypoint.file}`)
        if (boundaryKey(entrypoint.hostBoundary) !== boundaryKey(first.hostBoundary)) {
          return yield* fail(`host boundary drift: ${entrypoint.file}`)
        }
        return yield* fail(`source hash drift: ${entrypoint.file}`)
      }
      if (entrypoint.invokedBy.some((link) => !validPath(link.file) || !tracked.has(link.file))) {
        return yield* fail(`invocation link is not a tracked file: ${entrypoint.file}`)
      }
      const links = entrypoint.invokedBy.map(invocationKey)
      if (new Set(links).size !== links.length) {
        return yield* fail(`duplicate invocation link: ${entrypoint.file}`)
      }
      const expectedLinks = discovered.map(({ invocation }) => invocationKey(invocation)).sort(compareText)
      const actualLinks = [...links].sort(compareText)
      if (actualLinks.length !== expectedLinks.length || actualLinks.some((key, index) => key !== expectedLinks[index])) {
        return yield* fail(`invocation bijection failed: ${entrypoint.file}`)
      }
      if (entrypoint.kind === "registered-host-launcher" && entrypoint.file !== ".githooks/pre-commit") {
        return yield* fail(`registered host launcher is not exact: ${entrypoint.file}`)
      }
      if (entrypoint.kind === "registered-host-fixture" && (
        entrypoint.file !== "scripts/fixtures/job-control.sh"
        || entrypoint.invokedBy.length !== 1
        || entrypoint.invokedBy[0]?.selector !== "host-primitive:job-control"
      )) {
        return yield* fail(`registered host fixture must have one exact invocation and primitive boundary: ${entrypoint.file}`)
      }
      if (entrypoint.kind === "effect-free-transport-shim" && entrypoint.file !== "apps/desktop/src/preload/index.ts") {
        return yield* fail(`Effect-free transport shim is not the preload entry: ${entrypoint.file}`)
      }
      const hostKind = entrypoint.kind === "registered-host-launcher" || entrypoint.kind === "registered-host-fixture"
      if (hostKind) {
        if (context.trackedModes.get(entrypoint.file) !== "100755") {
          return yield* fail(`host executable requires exact Git mode 100755: ${entrypoint.file}`)
        }
        if (entrypoint.sourceHash === undefined || context.sourceHashes.get(entrypoint.file) !== entrypoint.sourceHash) {
          return yield* fail(`host executable hash is stale: ${entrypoint.file}`)
        }
      } else if (entrypoint.sourceHash !== undefined) {
        return yield* fail(`non-host entrypoint cannot carry a source hash: ${entrypoint.file}`)
      }
      const runnerLinks = entrypoint.invokedBy.filter(({ selector }) => selector.startsWith("runner:"))
      const runnerRequired = entrypoint.kind === "effect-entrypoint" && sourceExtension.test(entrypoint.file) && entrypoint.file !== "test/architecture/effect-executable-inventory.test.ts"
      if ((runnerRequired && entrypoint.hostBoundary === undefined) || runnerLinks.length !== (entrypoint.hostBoundary === undefined ? 0 : 1)) {
        return yield* fail(`runner must be linked exactly once: ${entrypoint.file}`)
      }
    }

    for (const observation of observations) {
      if (!inventory.entrypoints.some(({ file }) => file === observation.file)) {
        return yield* fail(`discovered executable is absent from inventory: ${observation.file}`)
      }
    }
    return inventory
  }
)

const commandOutput = Effect.fn("ExecutableInventory.commandOutput")(
  (root: string, command: string, args: ReadonlyArray<string>) =>
    Effect.scoped(Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const handle = yield* spawner.spawn(ChildProcess.make(command, args, { cwd: root })).pipe(
        Effect.mapError((cause) => fail(`${command} could not start`, cause))
      )
      const [stdout, stderr, exitCode] = yield* Effect.all([
        handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
        handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
        handle.exitCode
      ], { concurrency: "unbounded" }).pipe(
        Effect.mapError((cause) => fail(`${command} failed`, cause))
      )
      if (exitCode !== 0) return yield* fail(`${command} exited ${exitCode}: ${stderr}`)
      return stdout
    }))
)

const manifestFiles = [
  "package.json",
  "apps/desktop/package.json",
  "packages/contracts/package.json",
  "packages/client-ts/package.json",
  "docs/architecture/package.json"
] as const

const Manifest = Schema.fromJsonString(Schema.Struct({
  module: Schema.optionalKey(Schema.String),
  scripts: Schema.optionalKey(Schema.Record(Schema.String, Schema.String))
}))

const sourcePathPattern = /(?:^|\s|["'])([A-Za-z0-9_./-]+\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|html))(?:$|\s|["'])/g

const jobControlGrammar: ReadonlyArray<RegExp> = [
  /^#!\/usr\/bin\/env bash$/,
  /^set -euo pipefail$/,
  /^set -m$/,
  /^mode="\$1"$/,
  /^shift$/,
  /^signal_job\(\) \{$/,
  /^  kill "-\$1" -- "-\$2"$/,
  /^\}$/,
  /^start_job\(\) \{$/,
  /^  true &$/,
  /^  if \[\[ "\$mode" == "guardian" \]\]; then$/,
  /^    \(kill -STOP "\$BASHPID"; exec "\$@"\) &$/,
  /^  else$/,
  /^    "\$@" &$/,
  /^  fi$/,
  /^  pid=\$!$/,
  /^  job_line="\$\(jobs -l %%\)"$/,
  /^  job_marker="\$\{job_line%% \*\}"$/,
  /^  job_number="\$\{job_marker#\[\}"$/,
  /^  job_number="\$\{job_number%%\]\*\}"$/,
  /^  job_pid="\$\(jobs -p "%\$job_number"\)"$/,
  /^  pgid="\$\(ps -o pgid= -p "\$pid"\)"$/,
  /^  pgid="\$\{pgid\/\/\[\[:space:\]\]\/\}"$/,
  /^  printf 'job=%%%s pid=%s jobPid=%s pgid=%s\\n' "\$job_number" "\$pid" "\$job_pid" "\$pgid"$/,
  /^  set \+e$/,
  /^  wait -f "%\$job_number" 2>\/dev\/null$/,
  /^  status=\$\?$/,
  /^  set -e$/,
  /^  wait %1 2>\/dev\/null \|\| true$/,
  /^  printf 'status=%s\\n' "\$status"$/,
  /^\}$/,
  /^if \[\[ "\$mode" == "signal" \]\]; then$/,
  /^  signal_job "\$1" "\$2"$/,
  /^  exit 0$/,
  /^fi$/,
  /^start_job "\$@"$/,
  /^if \[\[ "\$mode" == "guardian" \]\]; then$/,
  /^  kill -STOP "\$\$"$/,
  /^fi$/,
  /^exit "\$status"$/
]

export const validateJobControlFixtureSource = (source: string): void => {
  const lines = source.endsWith("\n") ? source.slice(0, -1).split("\n") : source.split("\n")
  if (lines.length !== jobControlGrammar.length || lines.some((line, index) => !jobControlGrammar[index]!.test(line))) {
    throw fail("job-control fixture grammar rejected unapproved shell syntax")
  }
}

const fallbackNodeBuiltins = new Set([
  "assert", "assert/strict", "async_hooks", "buffer", "child_process", "cluster", "console", "constants", "crypto", "dgram",
  "diagnostics_channel", "dns", "dns/promises", "domain", "events", "fs", "fs/promises", "http", "http2", "https", "module", "net", "os",
  "path", "path/posix", "path/win32", "perf_hooks", "process", "punycode", "querystring", "readline", "readline/promises", "repl", "sqlite",
  "stream", "stream/consumers", "stream/promises", "stream/web", "string_decoder", "sys", "test", "test/reporters", "timers", "timers/promises",
  "tls", "trace_events", "tty", "url", "util", "util/types", "v8", "vm", "wasi", "worker_threads", "zlib"
])

const forbiddenPreloadModule = (specifier: string, nodeBuiltins: ReadonlySet<string>) =>
  specifier.startsWith("node" + ":")
  || specifier === "effect"
  || specifier.startsWith("effect/")
  || specifier.startsWith("@effect/")
  || nodeBuiltins.has(specifier)

export const validatePreloadSource = (source: string, nodeBuiltins: ReadonlySet<string> = fallbackNodeBuiltins): void => {
  const sourceFile = ts.createSourceFile("preload.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const requireAliases = new Set(["require"])
  let changed = true
  while (changed) {
    changed = false
    const collectAliases = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        const initializer = node.initializer
        if (initializer !== undefined && ts.isIdentifier(initializer) && requireAliases.has(initializer.text) && !requireAliases.has(node.name.text)) {
          requireAliases.add(node.name.text)
          changed = true
        }
      }
      ts.forEachChild(node, collectAliases)
    }
    collectAliases(sourceFile)
  }
  const specifiers: Array<string> = []
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined && ts.isStringLiteralLike(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text)
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression !== undefined && ts.isStringLiteralLike(node.moduleReference.expression)) {
      specifiers.push(node.moduleReference.expression.text)
    }
    if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0]!) && (
      node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && requireAliases.has(node.expression.text))
    )) {
      specifiers.push(node.arguments[0]!.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  if (specifiers.some((specifier) => forbiddenPreloadModule(specifier, nodeBuiltins))) throw fail("preload transport shim imports Effect or Node platform services")
}

const executableKind = (file: string): ExecutableKind => {
  if (file === ".githooks/pre-commit") return "registered-host-launcher"
  if (file === "scripts/fixtures/job-control.sh") return "registered-host-fixture"
  if (file === "apps/desktop/src/preload/index.ts") return "effect-free-transport-shim"
  return "effect-entrypoint"
}

const defaultDeclaration = (file: string): typeof ExecutableDeclaration.Type =>
  file.endsWith(".html")
    ? { kind: "document", name: "<document>" }
    : file.endsWith(".sh") || file.startsWith(".githooks/")
      ? { kind: "script", name: "<script>" }
      : { kind: "module", name: "<module>" }

const sourceKind = (file: string) => file.endsWith(".tsx")
  ? ts.ScriptKind.TSX
  : file.endsWith(".jsx")
    ? ts.ScriptKind.JSX
    : file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs")
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS

const parseSource = (file: string, source: string) =>
  ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, sourceKind(file))

const declarationOf = (node: ts.Node): typeof ExecutableDeclaration.Type => {
  let current: ts.Node | undefined = node
  while (current !== undefined) {
    if (ts.isFunctionDeclaration(current) && current.name !== undefined) return { kind: "function", name: current.name.text }
    if (ts.isMethodDeclaration(current) && current.name !== undefined) return { kind: "method", name: current.name.getText() }
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) return { kind: "variable", name: current.name.text }
    current = current.parent
  }
  return { kind: "module", name: "<module>" }
}

interface ParsedRunner {
  readonly declaration: typeof ExecutableDeclaration.Type
  readonly construct: string
  readonly occurrence: number
}

const parseRunners = (sourceFile: ts.SourceFile): ReadonlyArray<ParsedRunner> => {
  const found: Array<{ readonly node: ts.Node; readonly construct: string }> = []
  const aliases = new Map([["Effect", "Effect"], ["NodeRuntime", "NodeRuntime"]])
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier) || statement.importClause?.namedBindings === undefined) continue
    const moduleName = statement.moduleSpecifier.text
    const bindings = statement.importClause.namedBindings
    if (ts.isNamespaceImport(bindings)) {
      if (moduleName === "effect") aliases.set(bindings.name.text, "Effect")
      if (moduleName === "@effect/platform-node/NodeRuntime") aliases.set(bindings.name.text, "NodeRuntime")
    } else {
      for (const element of bindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text
        if (moduleName === "effect" && imported === "Effect") aliases.set(element.name.text, "Effect")
        if (moduleName === "@effect/platform-node" && imported === "NodeRuntime") aliases.set(element.name.text, "NodeRuntime")
      }
    }
  }
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const owner = aliases.get(node.expression.getText(sourceFile)) ?? node.expression.getText(sourceFile)
      const method = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : node.argumentExpression !== undefined && ts.isStringLiteralLike(node.argumentExpression)
          ? node.argumentExpression.text
          : ""
      if ((owner === "NodeRuntime" && method === "runMain") || (owner === "Effect" && /^(?:runPromise|runPromiseExit|runSync|runSyncExit|runFork|runCallback)$/.test(method))) {
        found.push({ node, construct: `runner:${owner}.${method}` })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  const occurrences = new Map<string, number>()
  return found.flatMap(({ node, construct }) => {
    const declaration = declarationOf(node)
    if (declaration.kind !== "module") return []
    const key = `${declarationKey(declaration)}\u0000${construct}`
    const occurrence = occurrences.get(key) ?? 0
    occurrences.set(key, occurrence + 1)
    return [{ declaration, construct, occurrence }]
  })
}

const makeObservation = (
  file: string,
  invocation: Invocation,
  hostBoundary: BoundaryLink | undefined,
  sourceHash?: string
): ExecutableObservation => ({
  file,
  declaration: hostBoundary?.declaration ?? defaultDeclaration(file),
  kind: executableKind(file),
  invocation,
  ...(hostBoundary === undefined ? {} : { hostBoundary }),
  ...(sourceHash === undefined ? {} : { sourceHash })
})

const normalizeManifestPath = (manifest: string, file: string) => {
  const directory = manifest === "package.json" ? "" : manifest.slice(0, manifest.lastIndexOf("/") + 1)
  const joined = `${directory}${file}`
  const parts: Array<string> = []
  for (const part of joined.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") parts.pop()
    else parts.push(part)
  }
  return parts.join("/")
}

const sourceExtension = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/

const nativeLaunchApis = new Set(["spawn", "exec", "execFile", "fork", "spawnSync", "execSync", "execFileSync"])
const isChildProcessModule = (specifier: string) => specifier === "child_process" || specifier === `node${":"}child_process`

type LaunchApi = "effect" | "spawn" | "exec" | "execFile" | "fork" | "spawnSync" | "execSync" | "execFileSync"

interface SourceBinding {
  readonly file: string
  readonly expression: ts.Expression
  readonly scope: ReadonlyMap<string, SourceBinding>
}

interface WrapperBinding {
  readonly file: string
  readonly parameters: ReadonlyArray<string>
  readonly body: ts.Node
}

interface SourceModule {
  readonly file: string
  readonly sourceFile: ts.SourceFile
  readonly constants: ReadonlyMap<string, ts.Expression>
  readonly imports: ReadonlyMap<string, { readonly file: string; readonly imported: string }>
  readonly launchers: ReadonlyMap<string, LaunchApi>
  readonly namespaces: ReadonlyMap<string, "effect" | "effect-root" | "native">
  readonly wrappers: ReadonlyMap<string, WrapperBinding>
}

interface ChildDiscovery {
  readonly targets: ReadonlyArray<{ readonly target: string; readonly caller: string; readonly position: number }>
  readonly fixtureConsumers: ReadonlyArray<{ readonly caller: string; readonly position: number }>
}

const resolveSourceImport = (caller: string, specifier: string, tracked: ReadonlySet<string>): string | undefined => {
  if (!specifier.startsWith(".")) return undefined
  const base = normalizeManifestPath(caller, specifier)
  const extensionless = base.replace(/\.(?:js|mjs|cjs)$/, "")
  for (const candidate of [base, ...[base, extensionless].flatMap((prefix) => [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].map((extension) => `${prefix}${extension}`)), ...[base, extensionless].flatMap((prefix) => ["/index.ts", "/index.tsx", "/index.js"].map((extension) => `${prefix}${extension}`))]) {
    if (tracked.has(candidate)) return candidate
  }
  return undefined
}

const wrappedFunction = (expression: ts.Expression): ts.ArrowFunction | ts.FunctionExpression | undefined => {
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return expression
  if (!ts.isCallExpression(expression)) return undefined
  for (const argument of expression.arguments) {
    if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) return argument
  }
  return wrappedFunction(expression.expression)
}

const analyzeSourceModules = (
  parsedSources: ReadonlyMap<string, ts.SourceFile>,
  tracked: ReadonlySet<string>
): ReadonlyMap<string, SourceModule> => {
  const modules = new Map<string, SourceModule>()
  for (const [file, sourceFile] of parsedSources) {
    const constants = new Map<string, ts.Expression>()
    const imports = new Map<string, { readonly file: string; readonly imported: string }>()
    const launchers = new Map<string, LaunchApi>()
    const namespaces = new Map<string, "effect" | "effect-root" | "native">()
    const wrappers = new Map<string, WrapperBinding>()
    const namespaceDestructures: Array<{ readonly namespace: string; readonly imported: string; readonly local: string }> = []
    for (const statement of sourceFile.statements) {
      if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference) && statement.moduleReference.expression !== undefined && ts.isStringLiteralLike(statement.moduleReference.expression) && isChildProcessModule(statement.moduleReference.expression.text)) namespaces.set(statement.name.text, "native")
      if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier) && statement.importClause?.namedBindings !== undefined) {
        const specifier = statement.moduleSpecifier.text
        const importedFile = resolveSourceImport(file, specifier, tracked)
        const bindings = statement.importClause.namedBindings
        if (ts.isNamespaceImport(bindings)) {
          if (specifier === "effect/unstable/process") namespaces.set(bindings.name.text, "effect-root")
          if (specifier === "effect/unstable/process/ChildProcess") namespaces.set(bindings.name.text, "effect")
          if (isChildProcessModule(specifier)) namespaces.set(bindings.name.text, "native")
          if (importedFile !== undefined) imports.set(bindings.name.text, { file: importedFile, imported: "*" })
        } else {
          for (const element of bindings.elements) {
            const imported = element.propertyName?.text ?? element.name.text
            const local = element.name.text
            if (specifier === "effect/unstable/process" && imported === "ChildProcess") namespaces.set(local, "effect")
            if (specifier === "effect/unstable/process/ChildProcess" && imported === "make") launchers.set(local, "effect")
            if ((isChildProcessModule(specifier)) && nativeLaunchApis.has(imported)) launchers.set(local, imported as LaunchApi)
            if (importedFile !== undefined) imports.set(local, { file: importedFile, imported })
          }
        }
      }
      if (ts.isFunctionDeclaration(statement) && statement.name !== undefined && statement.body !== undefined) {
        wrappers.set(statement.name.text, { file, parameters: statement.parameters.flatMap((parameter) => ts.isIdentifier(parameter.name) ? [parameter.name.text] : []), body: statement.body })
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) {
            constants.set(declaration.name.text, declaration.initializer)
            const implementation = wrappedFunction(declaration.initializer)
            if (implementation !== undefined) {
              wrappers.set(declaration.name.text, { file, parameters: implementation.parameters.flatMap((parameter) => ts.isIdentifier(parameter.name) ? [parameter.name.text] : []), body: implementation.body })
            }
          }
          if (ts.isObjectBindingPattern(declaration.name) && declaration.initializer !== undefined) {
            for (const element of declaration.name.elements) {
              if (!ts.isIdentifier(element.name)) continue
              const imported = element.propertyName?.getText(sourceFile) ?? element.name.text
              if (ts.isCallExpression(declaration.initializer) && ts.isIdentifier(declaration.initializer.expression) && declaration.initializer.expression.text === "require" && declaration.initializer.arguments[0] !== undefined && ts.isStringLiteralLike(declaration.initializer.arguments[0]) && isChildProcessModule(declaration.initializer.arguments[0].text) && nativeLaunchApis.has(imported)) launchers.set(element.name.text, imported as LaunchApi)
              if (ts.isIdentifier(declaration.initializer)) namespaceDestructures.push({ namespace: declaration.initializer.text, imported, local: element.name.text })
            }
          }
        }
      }
    }
    const collectLocalConstants = (astNode: ts.Node) => {
      if (ts.isVariableDeclaration(astNode) && ts.isIdentifier(astNode.name) && astNode.initializer !== undefined && !constants.has(astNode.name.text)) constants.set(astNode.name.text, astNode.initializer)
      ts.forEachChild(astNode, collectLocalConstants)
    }
    collectLocalConstants(sourceFile)
    let changed = true
    while (changed) {
      changed = false
      for (const [name, expression] of constants) {
        if (ts.isIdentifier(expression) && launchers.has(expression.text) && !launchers.has(name)) {
          launchers.set(name, launchers.get(expression.text)!)
          changed = true
        }
        if (ts.isIdentifier(expression) && namespaces.has(expression.text) && !namespaces.has(name)) {
          namespaces.set(name, namespaces.get(expression.text)!)
          changed = true
        }
        if (ts.isPropertyAccessExpression(expression)) {
          const requiredNamespace = ts.isCallExpression(expression.expression) && ts.isIdentifier(expression.expression.expression) && expression.expression.expression.text === "require" && expression.expression.arguments[0] !== undefined && ts.isStringLiteralLike(expression.expression.arguments[0]) && isChildProcessModule(expression.expression.arguments[0].text)
          const namespace = requiredNamespace ? "native" : namespaces.get(expression.expression.getText(sourceFile))
          const api = namespace === "native" && nativeLaunchApis.has(expression.name.text) ? expression.name.text as LaunchApi : namespace === "effect" && expression.name.text === "make" ? "effect" : undefined
          if (api !== undefined && !launchers.has(name)) {
            launchers.set(name, api)
            changed = true
          }
        }
        if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === "require" && expression.arguments[0] !== undefined && ts.isStringLiteralLike(expression.arguments[0]) && isChildProcessModule(expression.arguments[0].text) && !namespaces.has(name)) {
          namespaces.set(name, "native")
          changed = true
        }
      }
      for (const binding of namespaceDestructures) {
        if (namespaces.get(binding.namespace) === "native" && nativeLaunchApis.has(binding.imported) && !launchers.has(binding.local)) {
          launchers.set(binding.local, binding.imported as LaunchApi)
          changed = true
        }
      }
    }
    modules.set(file, { file, sourceFile, constants, imports, launchers, namespaces, wrappers })
  }
  return modules
}

const discoverChildTargets = (
  parsedSources: ReadonlyMap<string, ts.SourceFile>,
  tracked: ReadonlySet<string>
): ChildDiscovery => {
  const modules = analyzeSourceModules(parsedSources, tracked)
  const resolveExport = (file: string, name: string): ts.Expression | undefined => modules.get(file)?.constants.get(name)
  const resolveValues = (expression: ts.Expression, file: string, scope: ReadonlyMap<string, SourceBinding>, seen = new Set<string>()): ReadonlyArray<string> => {
    if (ts.isStringLiteralLike(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return [expression.text]
    if (ts.isTemplateExpression(expression)) {
      const parts = [expression.head.text, ...expression.templateSpans.flatMap((span) => [...resolveValues(span.expression, file, scope, seen), span.literal.text])]
      return [parts.join("")]
    }
    if (ts.isIdentifier(expression)) {
      const scoped = scope.get(expression.text)
      if (scoped !== undefined) return resolveValues(scoped.expression, scoped.file, scoped.scope, seen)
      const key = `${file}\0${expression.text}`
      if (seen.has(key)) return []
      const module = modules.get(file)
      const local = module?.constants.get(expression.text)
      if (local !== undefined) return resolveValues(local, file, scope, new Set([...seen, key]))
      const imported = module?.imports.get(expression.text)
      if (imported !== undefined) {
        const exported = resolveExport(imported.file, imported.imported)
        if (exported !== undefined) return resolveValues(exported, imported.file, new Map(), new Set([...seen, key]))
      }
      return []
    }
    if (ts.isArrayLiteralExpression(expression)) return expression.elements.flatMap((element) => ts.isExpression(element) ? resolveValues(element, file, scope, seen) : [])
    if (ts.isSpreadElement(expression)) return resolveValues(expression.expression, file, scope, seen)
    if (ts.isConditionalExpression(expression)) return [...resolveValues(expression.whenTrue, file, scope, seen), ...resolveValues(expression.whenFalse, file, scope, seen)]
    if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression) && expression.expression.name.text === "join") {
      const values = expression.arguments.map((argument) => resolveValues(argument, file, scope, seen))
      return values.every((part) => part.length === 1) ? [values.map(([value]) => value).join("/").replace(/\/+/g, "/")] : values.flat()
    }
    if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression) && /^(?:succeed|make)$/.test(expression.expression.name.text)) return expression.arguments.flatMap((argument) => resolveValues(argument, file, scope, seen))
    return []
  }
  const normalizeTarget = (caller: string, value: string): string | undefined => {
    const tokens = value.split(/\s+/).map((token) => token.replace(/^['"]|['"]$/g, ""))
    for (const token of [value, ...tokens]) {
      const normalized = token.startsWith("./") || token.startsWith("../") ? normalizeManifestPath(caller, token) : token
      if (tracked.has(normalized) && (sourceExtension.test(normalized) || normalized === "scripts/fixtures/job-control.sh")) return normalized
      const suffixMatches = [...tracked].filter((candidate) => (sourceExtension.test(candidate) || candidate === "scripts/fixtures/job-control.sh") && token.endsWith(candidate))
      if (suffixMatches.length === 1) return suffixMatches[0]
      if (!token.includes("/")) {
        const matches = [...tracked].filter((candidate) => (sourceExtension.test(candidate) || candidate === "scripts/fixtures/job-control.sh") && candidate.endsWith(`/${token}`))
        if (matches.length === 1) return matches[0]
      }
    }
    return undefined
  }
  const launchApi = (expression: ts.Expression, file: string): LaunchApi | undefined => {
    const module = modules.get(file)
    if (ts.isIdentifier(expression)) return module?.launchers.get(expression.text)
    if (!ts.isPropertyAccessExpression(expression)) return undefined
    const ownerText = expression.expression.getText(module?.sourceFile)
    const namespace = module?.namespaces.get(ownerText)
    if (namespace === "effect" && expression.name.text === "make") return "effect"
    if (namespace === "native" && nativeLaunchApis.has(expression.name.text)) return expression.name.text as LaunchApi
    if (ts.isPropertyAccessExpression(expression.expression) && module?.namespaces.get(expression.expression.expression.getText(module.sourceFile)) === "effect-root" && expression.expression.name.text === "ChildProcess" && expression.name.text === "make") return "effect"
    return undefined
  }
  const wrapper = (expression: ts.Expression, file: string): WrapperBinding | undefined => {
    if (!ts.isIdentifier(expression)) return undefined
    const module = modules.get(file)
    const local = module?.wrappers.get(expression.text)
    if (local !== undefined) return local
    const imported = module?.imports.get(expression.text)
    return imported === undefined ? undefined : modules.get(imported.file)?.wrappers.get(imported.imported)
  }
  const targets: Array<{ readonly target: string; readonly caller: string; readonly position: number }> = []
  const fixtureConsumers = new Map<string, { readonly caller: string; readonly position: number }>()
  const inspectCall = (call: ts.CallExpression, file: string, scope: ReadonlyMap<string, SourceBinding>, position: number, stack: ReadonlySet<string>, observationCaller: string) => {
    const api = launchApi(call.expression, file)
    if (api !== undefined) {
      const command = call.arguments[0]
      const commandValues = command === undefined ? [] : resolveValues(command, file, scope)
      const interpreter = command !== undefined && (commandValues.some((value) => /^(?:node|tsx|bash)$/.test(value)) || /process\.execPath/.test(command.getText(modules.get(file)?.sourceFile)))
      const expressions = api === "fork" || api === "exec" || api === "execSync"
        ? call.arguments.slice(0, 1)
        : interpreter ? call.arguments.slice(0, 2) : call.arguments.slice(0, 1)
      const values = expressions.flatMap((expression) => resolveValues(expression, file, scope))
      const resolved = [...new Set(values.flatMap((value) => {
        const target = normalizeTarget(file, value)
        return target === undefined ? [] : [target]
      }))]
      const independentlyResolved = scope.size === 0 ? new Set<string>() : new Set(expressions.flatMap((expression) => resolveValues(expression, file, new Map())).flatMap((value) => {
        const target = normalizeTarget(file, value)
        return target === undefined ? [] : [target]
      }))
      if (resolved.length === 0 && expressions.some((expression) => sourceExtension.test(expression.getText(modules.get(file)?.sourceFile)))) throw fail(`unresolved first-party launch target: ${file}`)
      for (const target of resolved.filter((target) => !independentlyResolved.has(target))) {
        if (target === "scripts/fixtures/job-control.sh") fixtureConsumers.set(`${file}\0${call.getStart(modules.get(file)?.sourceFile)}`, { caller: file, position: call.getStart(modules.get(file)?.sourceFile) })
        else targets.push({ target, caller: observationCaller, position })
      }
      return
    }
    const helper = wrapper(call.expression, file)
    if (helper === undefined) return
    if (scope.size > 0 && call.arguments.some((argument) => resolveValues(argument, file, new Map()).some((value) => normalizeTarget(file, value) !== undefined))) return
    const key = `${helper.file}\0${helper.body.pos}`
    if (stack.has(key)) return
    const bindings = new Map<string, SourceBinding>()
    helper.parameters.forEach((parameter, index) => {
      const expression = call.arguments[index]
      if (expression !== undefined) bindings.set(parameter, { file, expression, scope })
    })
    const visitHelper = (astNode: ts.Node) => {
      if (ts.isCallExpression(astNode)) inspectCall(astNode, helper.file, bindings, position, new Set([...stack, key]), observationCaller)
      ts.forEachChild(astNode, visitHelper)
    }
    visitHelper(helper.body)
  }
  for (const [file, module] of modules) {
    const visit = (astNode: ts.Node) => {
      if (ts.isCallExpression(astNode)) inspectCall(astNode, file, new Map(), astNode.getStart(module.sourceFile), new Set(), file)
      if (ts.isPropertyAssignment(astNode) && /^(?:sourceEntry|backendCommand)$/.test(astNode.name.getText(module.sourceFile))) {
        for (const value of resolveValues(astNode.initializer, file, new Map())) {
          const target = normalizeTarget(file, value)
          if (target !== undefined && target !== "scripts/fixtures/job-control.sh") targets.push({ target, caller: file, position: astNode.getStart(module.sourceFile) })
        }
      }
      ts.forEachChild(astNode, visit)
    }
    visit(module.sourceFile)
  }
  return { targets: targets.sort((left, right) => compareText(left.caller, right.caller) || left.position - right.position), fixtureConsumers: [...fixtureConsumers.values()] }
}

const manifestSourceTargets = (command: string): ReadonlyArray<string> => {
  const tokens = [...command.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g)].map((match) => match[1] ?? match[2] ?? match[3] ?? "")
  const targets: Array<string> = []
  const isOperator = (token: string) => /^(?:&&|\|\||;)$/.test(token)
  for (let index = 0; index < tokens.length; index += 1) {
    const launcher = tokens[index]!
    if (launcher !== "tsx" && launcher !== "node" && launcher !== "vitest") continue
    for (let cursor = index + 1; cursor < tokens.length && !isOperator(tokens[cursor]!); cursor += 1) {
      const token = tokens[cursor]!.replace(/[;,]$/, "")
      if (sourcePathPattern.test(` ${token} `)) {
        sourcePathPattern.lastIndex = 0
        targets.push(token)
        if (launcher !== "vitest") break
      }
      sourcePathPattern.lastIndex = 0
    }
  }
  return targets
}

export const discoverExecutableInventory = Effect.fn("ExecutableInventory.discover")(
  function*(root: string) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const crypto = yield* Crypto.Crypto
    const trackedOutput = yield* commandOutput(root, "git", ["ls-files", "-s", "-z"])
    const trackedFiles: Array<string> = []
    const trackedModes = new Map<string, string>()
    for (const record of trackedOutput.split("\0").filter(Boolean)) {
      const match = /^(\d{6}) [0-9a-f]+ 0\t(.+)$/.exec(record)
      if (match === null || !validPath(match[2] ?? "")) return yield* fail("git tracked-mode output is malformed")
      const file = match[2]!
      trackedFiles.push(file)
      trackedModes.set(file, match[1]!)
    }
    const tracked = new Set(trackedFiles)
    const sources = new Map<string, string>()
    for (const file of trackedFiles.filter((file) => sourceExtension.test(file) || file.endsWith(".sh") || file.startsWith(".githooks/"))) {
      sources.set(file, yield* fs.readFileString(path.join(root, file)).pipe(Effect.mapError((cause) => fail(`cannot read ${file}`, cause))))
    }
    const parsedSources = new Map<string, ts.SourceFile>()
    const parsedRunners = new Map<string, ReadonlyArray<ParsedRunner>>()
    for (const [file, source] of sources) {
      if (!sourceExtension.test(file)) continue
      const parsed = parseSource(file, source)
      parsedSources.set(file, parsed)
      parsedRunners.set(file, parseRunners(parsed))
    }
    const registeredRunners = effectHostBoundaries.filter((boundary) => tracked.has(boundary.file) && boundary.declaration === "module:<module>" && boundary.construct.startsWith("runner:"))
    const runnerBoundaries = new Map<string, BoundaryLink>()
    for (const [file, runners] of parsedRunners) {
      if (runners.length > 1) return yield* fail(`multiple module runners discovered: ${file}`)
      for (const runner of runners) {
        const matches = registeredRunners.filter((boundary) => boundary.file === file && boundary.declaration === declarationKey(runner.declaration) && boundary.construct === runner.construct && boundary.occurrence === runner.occurrence)
        if (matches.length !== 1) return yield* fail(`unregistered or ambiguous module runner: ${file}`)
        runnerBoundaries.set(file, runner)
      }
    }
    for (const boundary of registeredRunners) {
      const parsed = parsedRunners.get(boundary.file) ?? []
      if (!parsed.some((runner) => declarationKey(runner.declaration) === boundary.declaration && runner.construct === boundary.construct && runner.occurrence === boundary.occurrence)) {
        return yield* fail(`registered module runner is stale: ${boundary.file}`)
      }
    }

    const childDiscovery = yield* Effect.try({
      try: () => discoverChildTargets(parsedSources, tracked),
      catch: (cause) => cause instanceof ExecutableInventoryError ? cause : fail("child launch discovery failed", cause)
    })
    if (tracked.has("scripts/fixtures/job-control.sh") && childDiscovery.fixtureConsumers.length !== 1) {
      return yield* fail(`job-control fixture must have exactly one independently discovered launch consumer occurrence, found ${childDiscovery.fixtureConsumers.length}`)
    }

    const sourceHashes = new Map<string, string>()
    const observations: Array<ExecutableObservation> = []
    const add = (file: string, invocation: Invocation) => {
      if (tracked.has(file)) observations.push(makeObservation(file, invocation, runnerBoundaries.get(file), sourceHashes.get(file)))
    }

    const selectedHosts = trackedFiles.filter((file) => trackedModes.get(file) === "100755" || (sources.get(file)?.startsWith("#!") ?? false)).sort(compareText)
    for (const file of selectedHosts) {
      if (file !== ".githooks/pre-commit" && file !== "scripts/fixtures/job-control.sh") return yield* fail(`unregistered host executable: ${file}`)
      const source = sources.get(file) ?? ""
      if (file === "scripts/fixtures/job-control.sh") {
        yield* Effect.try({ try: () => validateJobControlFixtureSource(source), catch: (cause) => cause instanceof ExecutableInventoryError ? cause : fail("job-control fixture grammar validation failed", cause) })
      }
      const bytes = yield* fs.readFile(path.join(root, file)).pipe(Effect.mapError((cause) => fail(`cannot hash ${file}`, cause)))
      const digest = yield* crypto.digest("SHA-256", bytes).pipe(Effect.mapError((cause) => fail(`cannot hash ${file}`, cause)))
      sourceHashes.set(file, Encoding.encodeHex(digest))
      const fixtureConsumer = childDiscovery.fixtureConsumers[0]
      observations.push(makeObservation(file, file === ".githooks/pre-commit"
        ? { file, selector: "host:git-pre-commit", occurrence: 0 }
        : { file: fixtureConsumer?.caller ?? "", selector: "host-primitive:job-control", occurrence: 0 }, undefined, sourceHashes.get(file)))
    }

    for (const manifestFile of manifestFiles.filter((file) => tracked.has(file))) {
      const manifest = yield* Schema.decodeUnknownEffect(Manifest)(yield* fs.readFileString(path.join(root, manifestFile))).pipe(Effect.mapError((cause) => fail(`cannot decode ${manifestFile}`, cause)))
      if (manifest.module !== undefined) add(normalizeManifestPath(manifestFile, manifest.module), { file: manifestFile, selector: "manifest:module", occurrence: 0 })
      for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
        let occurrence = 0
        for (const candidate of manifestSourceTargets(command)) {
          const file = normalizeManifestPath(manifestFile, candidate)
          if (tracked.has(file)) add(file, { file: manifestFile, selector: `manifest:scripts.${name}`, occurrence: occurrence++ })
        }
      }
    }

    if (tracked.has("scripts/build.ts")) {
      const buildSource = sources.get("scripts/build.ts") ?? ""
      let occurrence = 0
      for (const match of buildSource.matchAll(/\["([^"]+\.(?:ts|tsx))",\s*"dist\//g)) {
        if (match[1] !== undefined) add(match[1], { file: "scripts/build.ts", selector: "esbuild:BUILD_ENTRIES", occurrence: occurrence++ })
      }
    }
    if (tracked.has("apps/desktop/electron.vite.config.ts")) {
      const electronConfig = sources.get("apps/desktop/electron.vite.config.ts") ?? ""
      for (const match of electronConfig.matchAll(/\b(main|preload|renderer):\s*\{[\s\S]*?input:\s*resolve\(here,\s*"([^"]+)"\)/g)) {
        if (match[1] !== undefined && match[2] !== undefined) add(`apps/desktop/${match[2]}`, { file: "apps/desktop/electron.vite.config.ts", selector: `electron:${match[1]}`, occurrence: 0 })
      }
    }

    for (const [file, runners] of parsedRunners) {
      for (const runner of runners) add(file, { file, selector: runner.construct, occurrence: runner.occurrence })
      if (runners.length === 1 && file.startsWith("examples/") && !file.includes("/test/")) add(file, { file, selector: "example-entry", occurrence: 0 })
      if (runners.length === 1 && file.startsWith("bench/")) add(file, { file, selector: "benchmark-entry", occurrence: 0 })
    }

    const childOccurrences = new Map<string, number>()
    for (const { target, caller } of childDiscovery.targets) {
      const selector = `child-process:${target}`
      const key = `${caller}\u0000${selector}`
      const occurrence = childOccurrences.get(key) ?? 0
      childOccurrences.set(key, occurrence + 1)
      add(target, { file: caller, selector, occurrence })
    }

    const preload = "apps/desktop/src/preload/index.ts"
    if (tracked.has(preload)) {
      const builtinsOutput = yield* commandOutput(root, "node", ["--print", `require("node" + ":module").builtinModules.join("\\n")`])
      const builtins = builtinsOutput.trim().split("\n").filter(Boolean)
      if (builtins.length === 0) return yield* fail("Node builtin host adapter returned invalid output")
      const builtinSet = new Set(builtins.flatMap((specifier) => specifier.startsWith("node" + ":") ? [specifier.slice(5)] : [specifier]))
      yield* Effect.try({ try: () => validatePreloadSource(sources.get(preload) ?? "", builtinSet), catch: (cause) => cause instanceof ExecutableInventoryError ? cause : fail("preload transport shim validation failed", cause) })
    }

    const keys = observations.map(observationKey)
    if (new Set(keys).size !== keys.length) return yield* fail("discovery contains duplicate invocation identities")
    const sorted = [...observations].sort((left, right) => compareText(left.file, right.file) || compareText(invocationKey(left.invocation), invocationKey(right.invocation)))
    return {
      observations: sorted,
      trackedFiles: [...trackedFiles].sort(compareText),
      trackedModes,
      sourceHashes,
      entrypointCount: new Set(sorted.map(({ file }) => file)).size
    }
  }
)

export const validateExecutableInventory = Effect.fn("ExecutableInventory.validate")(
  function*(root: string) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const discovery = yield* discoverExecutableInventory(root)
    const inventoryFile = path.join(root, "effect-executable-inventory.json")
    const raw = yield* fs.readFileString(inventoryFile).pipe(
      Effect.mapError((cause) => fail("effect-executable-inventory.json is missing", cause))
    )
    const inventory = yield* Schema.decodeUnknownEffect(ExecutableInventoryJson)(raw).pipe(
      Effect.mapError((cause) => fail(`inventory JSON decode failed: ${String(cause)}`, cause))
    )
    const canonical = yield* Schema.encodeEffect(ExecutableInventoryJson)(inventory).pipe(
      Effect.mapError((cause) => fail(`inventory JSON encode failed: ${String(cause)}`, cause))
    )
    if (raw !== canonical) return yield* fail("inventory JSON is not canonical")
    const validated = yield* validateExecutableInventoryRecords(inventory, discovery.observations, discovery)
    return {
      entrypointCount: validated.entrypoints.length,
      observationCount: discovery.observations.length
    }
  }
)
