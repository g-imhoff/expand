import { Crypto, Data, Effect, Encoding, FileSystem, Option, Path, Schema, Stream } from "effect"
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
      const expectedLinks = discovered.map(({ invocation }) => invocationKey(invocation))
      if (links.length !== expectedLinks.length || links.some((key, index) => key !== expectedLinks[index])) {
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
  const checker = createTypeChecker(new Map([["preload.ts", sourceFile]]))
  const resolveSpecifier = (expression: ts.Expression, seen = new Set<ts.Declaration>()): string | undefined => {
    if (ts.isStringLiteralLike(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text
    if (!ts.isIdentifier(expression)) return undefined
    const declaration = symbolDeclaration(checker, expression)
    if (declaration === undefined || seen.has(declaration) || !ts.isVariableDeclaration(declaration) || declaration.initializer === undefined) return undefined
    return resolveSpecifier(declaration.initializer, new Set([...seen, declaration]))
  }
  const isRequire = (expression: ts.Expression, seen = new Set<ts.Declaration>()): boolean => {
    if (!ts.isIdentifier(expression)) return false
    const declaration = symbolDeclaration(checker, expression)
    if (declaration === undefined) return expression.text === "require"
    if (seen.has(declaration) || !ts.isVariableDeclaration(declaration) || declaration.initializer === undefined) return false
    return isRequire(declaration.initializer, new Set([...seen, declaration]))
  }
  const validateSpecifier = (expression: ts.Expression) => {
    const specifier = resolveSpecifier(expression)
    if (specifier === undefined || forbiddenPreloadModule(specifier, nodeBuiltins)) throw fail("preload transport shim imports Effect or Node platform services")
  }
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) validateSpecifier(node.moduleSpecifier)
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression !== undefined) validateSpecifier(node.moduleReference.expression)
    if (ts.isCallExpression(node) && node.arguments[0] !== undefined && (node.expression.kind === ts.SyntaxKind.ImportKeyword || isRequire(node.expression))) validateSpecifier(node.arguments[0])
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
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

const createTypeChecker = (sources: ReadonlyMap<string, ts.SourceFile>): ts.TypeChecker => {
  const options: ts.CompilerOptions = { allowJs: true, noLib: true, noResolve: true, target: ts.ScriptTarget.Latest }
  const fallback = ts.createCompilerHost(options)
  const host: ts.CompilerHost = {
    ...fallback,
    fileExists: (fileName) => sources.has(fileName),
    getSourceFile: (fileName) => sources.get(fileName),
    readFile: (fileName) => sources.get(fileName)?.text,
    writeFile: () => undefined
  }
  return ts.createProgram({ rootNames: [...sources.keys()], options, host }).getTypeChecker()
}

const symbolDeclaration = (checker: ts.TypeChecker, node: ts.Node): ts.Declaration | undefined =>
  checker.getSymbolAtLocation(node)?.declarations?.[0]

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

const parseRunners = (sourceFile: ts.SourceFile, checker: ts.TypeChecker): ReadonlyArray<ParsedRunner> => {
  const found: Array<{ readonly node: ts.Node; readonly construct: string }> = []
  type RunnerAlias = "Effect" | "EffectModule" | "NodeRuntime" | "PlatformNode" | `runner:${string}`
  const runnerPattern = /^(?:runPromise|runPromiseExit|runSync|runSyncExit|runFork|runCallback)$/
  const memberName = (expression: ts.PropertyAccessExpression | ts.ElementAccessExpression) => ts.isPropertyAccessExpression(expression)
    ? expression.name.text
    : expression.argumentExpression !== undefined && ts.isStringLiteralLike(expression.argumentExpression)
      ? expression.argumentExpression.text
      : undefined
  const importModule = (declaration: ts.Declaration): string | undefined => {
    const importDeclaration = declaration.parent === undefined ? undefined : ts.findAncestor(declaration, ts.isImportDeclaration)
    return importDeclaration !== undefined && ts.isStringLiteralLike(importDeclaration.moduleSpecifier) ? importDeclaration.moduleSpecifier.text : undefined
  }
  const resolveAlias = (expression: ts.Expression, seen = new Set<ts.Declaration>()): RunnerAlias | undefined => {
    if (ts.isIdentifier(expression)) {
      const declaration = symbolDeclaration(checker, expression)
      if (declaration === undefined || seen.has(declaration)) return undefined
      const nextSeen = new Set([...seen, declaration])
      const moduleName = importModule(declaration)
      if (ts.isImportClause(declaration)) {
        if (moduleName === "effect" || moduleName === "effect/Effect") return "Effect"
        if (moduleName === "@effect/platform-node/NodeRuntime") return "NodeRuntime"
      }
      if (ts.isNamespaceImport(declaration)) {
        if (moduleName === "effect") return "EffectModule"
        if (moduleName === "@effect/platform-node") return "PlatformNode"
        if (moduleName === "@effect/platform-node/NodeRuntime") return "NodeRuntime"
      }
      if (ts.isImportSpecifier(declaration)) {
        const imported = declaration.propertyName?.text ?? declaration.name.text
        if (moduleName === "effect" && imported === "Effect") return "Effect"
        if (moduleName === "effect" && runnerPattern.test(imported)) return `runner:Effect.${imported}`
        if (moduleName === "@effect/platform-node" && imported === "NodeRuntime") return "NodeRuntime"
        if (moduleName === "@effect/platform-node/NodeRuntime" && imported === "runMain") return "runner:NodeRuntime.runMain"
      }
      if (ts.isVariableDeclaration(declaration)) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) return resolveAlias(declaration.initializer, nextSeen)
        if (ts.isBindingElement(declaration.parent)) return undefined
      }
      if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)) {
        const variable = declaration.parent.parent
        if (ts.isVariableDeclaration(variable) && variable.initializer !== undefined) {
          const owner = resolveAlias(variable.initializer, nextSeen)
          const member = declaration.propertyName?.getText(sourceFile) ?? declaration.name.getText(sourceFile)
          if (owner === "NodeRuntime" && member === "runMain") return "runner:NodeRuntime.runMain"
          if (owner === "Effect" && runnerPattern.test(member)) return `runner:Effect.${member}`
        }
      }
      return undefined
    }
    if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) return undefined
    const owner = resolveAlias(expression.expression, seen)
    const member = memberName(expression)
    if (owner === "EffectModule" && member === "Effect") return "Effect"
    if (owner === "PlatformNode" && member === "NodeRuntime") return "NodeRuntime"
    if (owner === "NodeRuntime" && member === "runMain") return "runner:NodeRuntime.runMain"
    if (owner === "Effect" && member !== undefined && runnerPattern.test(member)) return `runner:Effect.${member}`
    return undefined
  }
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const construct = resolveAlias(node.expression)
      if (construct?.startsWith("runner:") === true) found.push({ node, construct })
      for (const argument of node.arguments) {
        const pointFreeConstruct = resolveAlias(argument)
        if (pointFreeConstruct?.startsWith("runner:") === true) found.push({ node: argument, construct: pointFreeConstruct })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  const occurrences = new Map<string, number>()
  return found.map(({ node, construct }) => {
    const declaration = declarationOf(node)
    const key = `${declarationKey(declaration)}\u0000${construct}`
    const occurrence = occurrences.get(key) ?? 0
    occurrences.set(key, occurrence + 1)
    return { declaration, construct, occurrence }
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
  readonly parameters: ReadonlyArray<ts.BindingName>
  readonly body: ts.Node
}

interface ResolvedWrapper extends WrapperBinding {
  readonly scope: ReadonlyMap<string, SourceBinding>
}

interface SourceModule {
  readonly file: string
  readonly sourceFile: ts.SourceFile
  readonly constants: ReadonlyMap<string, ts.Expression>
  readonly imports: ReadonlyMap<string, { readonly file: string; readonly imported: string }>
  readonly reExports: ReadonlyMap<string, { readonly file: string; readonly imported: string }>
  readonly launchers: ReadonlyMap<string, LaunchApi>
  readonly namespaces: ReadonlyMap<string, "effect" | "effect-root" | "native">
  readonly wrappers: ReadonlyMap<string, WrapperBinding>
  readonly wrapperDeclarations: ReadonlyMap<ts.Declaration, WrapperBinding>
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
  tracked: ReadonlySet<string>,
  checker: ts.TypeChecker
): ReadonlyMap<string, SourceModule> => {
  const modules = new Map<string, SourceModule>()
  for (const [file, sourceFile] of parsedSources) {
    const constants = new Map<string, ts.Expression>()
    const imports = new Map<string, { readonly file: string; readonly imported: string }>()
    const reExports = new Map<string, { readonly file: string; readonly imported: string }>()
    const launchers = new Map<string, LaunchApi>()
    const namespaces = new Map<string, "effect" | "effect-root" | "native">()
    const wrappers = new Map<string, WrapperBinding>()
    const wrapperDeclarations = new Map<ts.Declaration, WrapperBinding>()
    const namespaceDestructures: Array<{ readonly namespace: string; readonly imported: string; readonly local: string }> = []
    for (const statement of sourceFile.statements) {
      if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference) && statement.moduleReference.expression !== undefined && ts.isStringLiteralLike(statement.moduleReference.expression)) {
        const specifier = statement.moduleReference.expression.text
        if (isChildProcessModule(specifier)) namespaces.set(statement.name.text, "native")
        const importedFile = resolveSourceImport(file, specifier, tracked)
        if (importedFile !== undefined) imports.set(statement.name.text, { file: importedFile, imported: "default" })
      }
      if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier) && statement.importClause !== undefined) {
        const specifier = statement.moduleSpecifier.text
        const importedFile = resolveSourceImport(file, specifier, tracked)
        if (statement.importClause.name !== undefined && importedFile !== undefined) imports.set(statement.importClause.name.text, { file: importedFile, imported: "default" })
        const bindings = statement.importClause.namedBindings
        if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
          if (specifier === "effect/unstable/process") namespaces.set(bindings.name.text, "effect-root")
          if (specifier === "effect/unstable/process/ChildProcess") namespaces.set(bindings.name.text, "effect")
          if (isChildProcessModule(specifier)) namespaces.set(bindings.name.text, "native")
          if (importedFile !== undefined) imports.set(bindings.name.text, { file: importedFile, imported: "*" })
        } else if (bindings !== undefined) {
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
        const binding = { file, parameters: statement.parameters.map(({ name }) => name), body: statement.body }
        wrappers.set(statement.name.text, binding)
        if (statement.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.DefaultKeyword) === true) wrappers.set("default", binding)
      }
      if (ts.isExportAssignment(statement)) constants.set("default", statement.expression)
      if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
        if (statement.moduleSpecifier === undefined) {
          for (const element of statement.exportClause.elements) reExports.set(element.name.text, { file, imported: element.propertyName?.text ?? element.name.text })
        } else if (ts.isStringLiteralLike(statement.moduleSpecifier)) {
          const exportedFile = resolveSourceImport(file, statement.moduleSpecifier.text, tracked)
          if (exportedFile !== undefined) {
            for (const element of statement.exportClause.elements) reExports.set(element.name.text, { file: exportedFile, imported: element.propertyName?.text ?? element.name.text })
          }
        }
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) {
            constants.set(declaration.name.text, declaration.initializer)
            const implementation = wrappedFunction(declaration.initializer)
            if (implementation !== undefined) {
              wrappers.set(declaration.name.text, { file, parameters: implementation.parameters.map(({ name }) => name), body: implementation.body })
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
        if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
          const member = ts.isPropertyAccessExpression(expression)
            ? expression.name.text
            : expression.argumentExpression !== undefined && ts.isStringLiteralLike(expression.argumentExpression)
              ? expression.argumentExpression.text
              : undefined
          const requiredNamespace = ts.isCallExpression(expression.expression) && ts.isIdentifier(expression.expression.expression) && expression.expression.expression.text === "require" && expression.expression.arguments[0] !== undefined && ts.isStringLiteralLike(expression.expression.arguments[0]) && isChildProcessModule(expression.expression.arguments[0].text)
          const namespace = requiredNamespace ? "native" : namespaces.get(expression.expression.getText(sourceFile))
          const api = namespace === "native" && member !== undefined && nativeLaunchApis.has(member) ? member as LaunchApi : namespace === "effect" && member === "make" ? "effect" : undefined
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
    const collectWrappers = (node: ts.Node) => {
      let name: ts.Node | undefined
      let implementation: ts.FunctionLikeDeclaration | undefined
      if (ts.isFunctionDeclaration(node) && node.name !== undefined && node.body !== undefined) {
        name = node.name
        implementation = node
      } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
        const wrapped = wrappedFunction(node.initializer)
        if (wrapped !== undefined) {
          name = node.name
          implementation = wrapped
        }
      } else if (ts.isMethodDeclaration(node) && node.body !== undefined) {
        name = node.name
        implementation = node
      }
      if (name !== undefined && implementation?.body !== undefined) {
        const binding = { file, parameters: implementation.parameters.map(({ name: parameter }) => parameter), body: implementation.body }
        const symbol = checker.getSymbolAtLocation(name)
        for (const declaration of symbol?.declarations ?? []) wrapperDeclarations.set(declaration, binding)
      }
      ts.forEachChild(node, collectWrappers)
    }
    collectWrappers(sourceFile)
    modules.set(file, { file, sourceFile, constants, imports, reExports, launchers, namespaces, wrappers, wrapperDeclarations })
  }
  return modules
}

const discoverChildTargets = (
  parsedSources: ReadonlyMap<string, ts.SourceFile>,
  tracked: ReadonlySet<string>,
  checker: ts.TypeChecker
): ChildDiscovery => {
  const modules = analyzeSourceModules(parsedSources, tracked, checker)
  const resolveExport = (file: string, name: string, seen = new Set<string>()): ts.Expression | undefined => {
    const key = `${file}\0${name}`
    if (seen.has(key)) return undefined
    const module = modules.get(file)
    const local = module?.constants.get(name)
    if (local !== undefined) return local
    const reExport = module?.reExports.get(name)
    return reExport === undefined ? undefined : resolveExport(reExport.file, reExport.imported, new Set([...seen, key]))
  }
  const resolveExportWrapper = (file: string, name: string, seen = new Set<string>()): WrapperBinding | undefined => {
    const key = `${file}\0${name}`
    if (seen.has(key)) throw fail(`unresolved first-party launch: cyclic callable export flow: ${file}`)
    const nextSeen = new Set([...seen, key])
    const module = modules.get(file)
    const local = module?.wrappers.get(name)
    if (local !== undefined) return local
    const resolveExpression = (expression: ts.Expression, declarations = new Set<ts.Declaration>()): WrapperBinding | undefined => {
      if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return { file, parameters: expression.parameters.map(({ name: parameter }) => parameter), body: expression.body }
      if (!ts.isIdentifier(expression)) return undefined
      const declaration = symbolDeclaration(checker, expression)
      if (declaration === undefined || declarations.has(declaration)) return undefined
      const declaredWrapper = module?.wrapperDeclarations.get(declaration)
      if (declaredWrapper !== undefined) return declaredWrapper
      if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) return resolveExpression(declaration.initializer, new Set([...declarations, declaration]))
      if (ts.isImportEqualsDeclaration(declaration)) {
        const imported = module?.imports.get(declaration.name.text)
        return imported === undefined ? undefined : resolveExportWrapper(imported.file, imported.imported, nextSeen)
      }
      return undefined
    }
    const exported = module?.constants.get(name)
    if (exported !== undefined) {
      const exportedWrapper = resolveExpression(exported)
      if (exportedWrapper !== undefined) return exportedWrapper
    }
    const reExport = module?.reExports.get(name)
    return reExport === undefined ? undefined : resolveExportWrapper(reExport.file, reExport.imported, nextSeen)
  }
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
      const binding = localBinding(expression)
      if (binding !== undefined) {
        if (ts.isParameter(binding)) return []
        if (ts.isVariableDeclaration(binding) && ts.isIdentifier(binding.name) && binding.initializer !== undefined) return resolveValues(binding.initializer, file, scope, new Set([...seen, key]))
        if (ts.isImportSpecifier(binding)) {
          const imported = modules.get(file)?.imports.get(expression.text)
          if (imported === undefined) return []
          const exported = resolveExport(imported.file, imported.imported)
          return exported === undefined ? [] : resolveValues(exported, imported.file, new Map(), new Set([...seen, key]))
        }
        return []
      }
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
    if (ts.isObjectLiteralExpression(expression)) return expression.properties.flatMap((property) =>
      ts.isPropertyAssignment(property) ? resolveValues(property.initializer, file, scope, seen)
        : ts.isShorthandPropertyAssignment(property) ? resolveValues(property.name, file, scope, seen)
          : [])
    if (ts.isSpreadElement(expression)) return resolveValues(expression.expression, file, scope, seen)
    if (ts.isConditionalExpression(expression)) return [...resolveValues(expression.whenTrue, file, scope, seen), ...resolveValues(expression.whenFalse, file, scope, seen)]
    if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression) && expression.expression.name.text === "join") {
      const values = expression.arguments.map((argument) => resolveValues(argument, file, scope, seen))
      return values.every((part) => part.length === 1) ? [values.map(([value]) => value).join("/").replace(/\/+/g, "/")] : values.flat()
    }
    if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression) && /^(?:succeed|make)$/.test(expression.expression.name.text)) return expression.arguments.flatMap((argument) => resolveValues(argument, file, scope, seen))
    return []
  }
  const resolvedFlow = (expression: ts.Expression, file: string, scope: ReadonlyMap<string, SourceBinding>, seen = new Set<string>()): boolean => {
    if (ts.isStringLiteralLike(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return true
    if (ts.isTemplateExpression(expression)) return expression.templateSpans.every((span) => resolvedFlow(span.expression, file, scope, seen))
    if (ts.isIdentifier(expression)) {
      const scoped = scope.get(expression.text)
      if (scoped !== undefined) return resolvedFlow(scoped.expression, scoped.file, scoped.scope, seen)
      const key = `${file}\0${expression.text}`
      if (seen.has(key)) return false
      const binding = localBinding(expression)
      if (binding !== undefined) {
        if (ts.isParameter(binding)) return false
        if (ts.isVariableDeclaration(binding) && ts.isIdentifier(binding.name) && binding.initializer !== undefined) return resolvedFlow(binding.initializer, file, scope, new Set([...seen, key]))
        if (ts.isImportSpecifier(binding)) {
          const imported = modules.get(file)?.imports.get(expression.text)
          if (imported === undefined) return false
          const exported = resolveExport(imported.file, imported.imported)
          return exported !== undefined && resolvedFlow(exported, imported.file, new Map(), new Set([...seen, key]))
        }
        return false
      }
      const module = modules.get(file)
      const local = module?.constants.get(expression.text)
      if (local !== undefined) return resolvedFlow(local, file, scope, new Set([...seen, key]))
      const imported = module?.imports.get(expression.text)
      if (imported !== undefined) {
        const exported = resolveExport(imported.file, imported.imported)
        if (exported !== undefined) return resolvedFlow(exported, imported.file, new Map(), new Set([...seen, key]))
      }
      return false
    }
    if (ts.isArrayLiteralExpression(expression)) return expression.elements.every((element) => ts.isExpression(element) && resolvedFlow(element, file, scope, seen))
    if (ts.isObjectLiteralExpression(expression)) return expression.properties.every((property) =>
      ts.isPropertyAssignment(property) ? resolvedFlow(property.initializer, file, scope, seen)
        : ts.isShorthandPropertyAssignment(property) && resolvedFlow(property.name, file, scope, seen))
    if (ts.isSpreadElement(expression)) return resolvedFlow(expression.expression, file, scope, seen)
    if (ts.isConditionalExpression(expression)) return resolvedFlow(expression.whenTrue, file, scope, seen) && resolvedFlow(expression.whenFalse, file, scope, seen)
    if (ts.isPropertyAccessExpression(expression) && expression.expression.getText(modules.get(file)?.sourceFile) === "process" && expression.name.text === "execPath") return true
    if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression) && expression.expression.name.text === "join") return expression.arguments.every((argument) => resolvedFlow(argument, file, scope, seen))
    if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression) && /^(?:succeed|make)$/.test(expression.expression.name.text)) return expression.arguments.every((argument) => resolvedFlow(argument, file, scope, seen))
    return false
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
  const localBinding = (identifier: ts.Identifier): ts.Declaration | undefined => symbolDeclaration(checker, identifier)
  const importModule = (declaration: ts.Declaration): string | undefined => {
    const importDeclaration = ts.findAncestor(declaration, ts.isImportDeclaration)
    return importDeclaration !== undefined && ts.isStringLiteralLike(importDeclaration.moduleSpecifier) ? importDeclaration.moduleSpecifier.text : undefined
  }
  const requireFunction = (expression: ts.Expression, seen = new Set<ts.Declaration>()): boolean => {
    if (!ts.isIdentifier(expression)) return false
    const declaration = localBinding(expression)
    if (declaration === undefined) return expression.text === "require"
    if (seen.has(declaration) || !ts.isVariableDeclaration(declaration) || declaration.initializer === undefined) return false
    return requireFunction(declaration.initializer, new Set([...seen, declaration]))
  }
  const namespaceOf = (expression: ts.Expression, file: string, seen = new Set<ts.Declaration>()): "effect" | "effect-root" | "native" | undefined => {
    if (ts.isCallExpression(expression) && requireFunction(expression.expression) && expression.arguments[0] !== undefined && ts.isStringLiteralLike(expression.arguments[0]) && isChildProcessModule(expression.arguments[0].text)) return "native"
    if (!ts.isIdentifier(expression)) return undefined
    const declaration = localBinding(expression)
    if (declaration === undefined || seen.has(declaration)) return undefined
    const nextSeen = new Set([...seen, declaration])
    const specifier = importModule(declaration)
    if (ts.isImportClause(declaration) && isChildProcessModule(specifier ?? "")) return "native"
    if (ts.isNamespaceImport(declaration)) {
      if (isChildProcessModule(specifier ?? "")) return "native"
      if (specifier === "effect/unstable/process") return "effect-root"
      if (specifier === "effect/unstable/process/ChildProcess") return "effect"
    }
    if (ts.isImportSpecifier(declaration) && specifier === "effect/unstable/process" && (declaration.propertyName?.text ?? declaration.name.text) === "ChildProcess") return "effect"
    if (ts.isImportEqualsDeclaration(declaration) && ts.isExternalModuleReference(declaration.moduleReference) && declaration.moduleReference.expression !== undefined && ts.isStringLiteralLike(declaration.moduleReference.expression) && isChildProcessModule(declaration.moduleReference.expression.text)) return "native"
    if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) return namespaceOf(declaration.initializer, file, nextSeen)
    return undefined
  }
  const launchApi = (expression: ts.Expression, file: string, seen = new Set<ts.Declaration>()): LaunchApi | undefined => {
    if (ts.isIdentifier(expression)) {
      const declaration = localBinding(expression)
      if (declaration === undefined || seen.has(declaration)) return undefined
      const nextSeen = new Set([...seen, declaration])
      const specifier = importModule(declaration)
      if (ts.isImportSpecifier(declaration)) {
        const imported = declaration.propertyName?.text ?? declaration.name.text
        if (specifier === "effect/unstable/process/ChildProcess" && imported === "make") return "effect"
        if (isChildProcessModule(specifier ?? "") && nativeLaunchApis.has(imported)) return imported as LaunchApi
      }
      if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)) {
        const variable = declaration.parent.parent
        if (ts.isVariableDeclaration(variable) && variable.initializer !== undefined) {
          const imported = declaration.propertyName?.getText(modules.get(file)?.sourceFile) ?? declaration.name.getText(modules.get(file)?.sourceFile)
          return namespaceOf(variable.initializer, file) === "native" && nativeLaunchApis.has(imported) ? imported as LaunchApi : undefined
        }
      }
      if (ts.isVariableDeclaration(declaration)) {
        if (declaration.initializer !== undefined) return launchApi(declaration.initializer, file, nextSeen)
        const loop = declaration.parent.parent
        if (ts.isForOfStatement(loop) && ts.isArrayLiteralExpression(loop.expression) && loop.expression.elements.length === 1 && ts.isExpression(loop.expression.elements[0]!)) {
          return launchApi(loop.expression.elements[0]!, file, nextSeen)
        }
      }
      return undefined
    }
    if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) return undefined
    const member = ts.isPropertyAccessExpression(expression)
      ? expression.name.text
      : expression.argumentExpression !== undefined && ts.isStringLiteralLike(expression.argumentExpression)
        ? expression.argumentExpression.text
        : undefined
    const namespace = namespaceOf(expression.expression, file)
    if (namespace === "effect" && member === "make") return "effect"
    if (namespace === "native" && member !== undefined && nativeLaunchApis.has(member)) return member as LaunchApi
    if (ts.isPropertyAccessExpression(expression) && ts.isPropertyAccessExpression(expression.expression) && namespaceOf(expression.expression.expression, file) === "effect-root" && expression.expression.name.text === "ChildProcess" && expression.name.text === "make") return "effect"
    return undefined
  }
  const bindParameters = (
    helper: WrapperBinding,
    argumentsList: ReadonlyArray<ts.Expression>,
    callerFile: string,
    callerScope: ReadonlyMap<string, SourceBinding>,
    inherited: ReadonlyMap<string, SourceBinding>
  ): ReadonlyMap<string, SourceBinding> => {
    const bindings = new Map(inherited)
    const bind = (parameter: ts.BindingName, argument: ts.Expression | undefined) => {
      if (ts.isIdentifier(parameter)) {
        if (argument !== undefined) bindings.set(parameter.text, { file: callerFile, expression: argument, scope: callerScope })
        return
      }
      if (!ts.isObjectBindingPattern(parameter) || argument === undefined || !ts.isObjectLiteralExpression(argument)) return
      for (const element of parameter.elements) {
        if (!ts.isIdentifier(element.name)) continue
        const propertyName = element.propertyName?.getText(modules.get(helper.file)?.sourceFile) ?? element.name.text
        const property = argument.properties.find((candidate): candidate is ts.PropertyAssignment | ts.ShorthandPropertyAssignment =>
          (ts.isPropertyAssignment(candidate) || ts.isShorthandPropertyAssignment(candidate)) && candidate.name.getText(modules.get(callerFile)?.sourceFile) === propertyName)
        if (property === undefined) continue
        const value = ts.isPropertyAssignment(property) ? property.initializer : property.name
        bindings.set(element.name.text, { file: callerFile, expression: value, scope: callerScope })
      }
    }
    helper.parameters.forEach((parameter, index) => bind(parameter, argumentsList[index]))
    return bindings
  }
  const wrapper = (expression: ts.Expression, file: string, scope: ReadonlyMap<string, SourceBinding>, seen = new Set<ts.Declaration>()): ResolvedWrapper | undefined => {
    if (ts.isParenthesizedExpression(expression)) return wrapper(expression.expression, file, scope, seen)
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return { file, parameters: expression.parameters.map(({ name }) => name), body: expression.body, scope }
    if (ts.isCallExpression(expression)) {
      const factory = wrapper(expression.expression, file, scope, seen)
      if (factory === undefined) return undefined
      const factoryScope = bindParameters(factory, [...expression.arguments], file, scope, factory.scope)
      const returned: Array<ts.Expression> = []
      if (ts.isExpression(factory.body)) returned.push(factory.body)
      else {
        const collectReturns = (node: ts.Node) => {
          if (node !== factory.body && ts.isFunctionLike(node)) return
          if (ts.isReturnStatement(node) && node.expression !== undefined) returned.push(node.expression)
          else ts.forEachChild(node, collectReturns)
        }
        collectReturns(factory.body)
      }
      return returned.length === 1 ? wrapper(returned[0]!, factory.file, factoryScope, seen) : undefined
    }
    const module = modules.get(file)
    const symbolNode = ts.isIdentifier(expression)
      ? expression
      : ts.isPropertyAccessExpression(expression)
        ? expression.name
        : ts.isElementAccessExpression(expression) && expression.argumentExpression !== undefined
          ? expression.argumentExpression
          : undefined
    const resolvedDeclaration = symbolNode === undefined ? undefined : symbolDeclaration(checker, symbolNode)
    if (resolvedDeclaration !== undefined && !seen.has(resolvedDeclaration)) {
      const nextSeen = new Set([...seen, resolvedDeclaration])
      for (const candidate of modules.values()) {
        const local = candidate.wrapperDeclarations.get(resolvedDeclaration)
        if (local !== undefined) return { ...local, scope }
      }
      if (ts.isVariableDeclaration(resolvedDeclaration) && resolvedDeclaration.initializer !== undefined) return wrapper(resolvedDeclaration.initializer, file, scope, nextSeen)
    }
    if (!ts.isIdentifier(expression)) return undefined
    const imported = module?.imports.get(expression.text)
    const importedWrapper = imported === undefined ? undefined : resolveExportWrapper(imported.file, imported.imported)
    return importedWrapper === undefined ? undefined : { ...importedWrapper, scope: new Map() }
  }
  const targets: Array<{ readonly target: string; readonly caller: string; readonly position: number }> = []
  const fixtureConsumers = new Map<string, { readonly caller: string; readonly position: number }>()
  const unresolvedDeclarations = new Set<string>()
  const provenDeclarations = new Set<string>()
  const calledDeclarations = new Set<string>()
  const declarationIdentity = (call: ts.CallExpression, file: string) => {
    const owner = ts.findAncestor(call, (node) => ts.isFunctionLike(node) && "body" in node)
    const body = owner !== undefined && "body" in owner ? owner.body as ts.ConciseBody | undefined : undefined
    if (body === undefined || ![...modules.get(file)?.wrapperDeclarations.values() ?? []].some((wrapper) => wrapper.body === body)) return undefined
    return `${file}\0${body.pos}`
  }
  const exactExternalBackendCommand = (call: ts.CallExpression, file: string, command: ts.Expression | undefined) => {
    if (file !== "packages/client-ts/adapters/node-spawn.ts" || command === undefined || !ts.isIdentifier(command)) return false
    const owner = ts.findAncestor(call, (node) => ts.isFunctionLike(node) && "body" in node)
    if (owner === undefined) return false
    const declaration = ts.findAncestor(owner, ts.isVariableDeclaration)
    if (declaration === undefined || !ts.isIdentifier(declaration.name) || declaration.name.text !== "spawnResolvedBackend") return false
    const executable = localBinding(command)
    if (executable === undefined || !ts.isBindingElement(executable) || !ts.isArrayBindingPattern(executable.parent)) return false
    const commandDeclaration = executable.parent.parent
    if (!ts.isVariableDeclaration(commandDeclaration) || commandDeclaration.initializer === undefined || !ts.isIdentifier(commandDeclaration.initializer) || commandDeclaration.initializer.text !== "command") return false
    const parameter = localBinding(commandDeclaration.initializer)
    return parameter !== undefined && ts.isParameter(parameter) && ts.isIdentifier(parameter.name) && parameter.name.text === "command" && parameter.parent === owner
  }
  const sourceLikeTarget = (value: string) => value.split(/\s+/).some((token) => /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|sh|bash|zsh)(?:["']?)$/.test(token))
  const inspectCall = (call: ts.CallExpression, file: string, scope: ReadonlyMap<string, SourceBinding>, position: number, stack: ReadonlySet<string>, observationCaller: string, declarationAnalysis = false, invokedHelper = false) => {
    const api = launchApi(call.expression, file)
    if (api !== undefined) {
      const command = call.arguments[0]
      const commandValues = command === undefined ? [] : resolveValues(command, file, scope)
      const externalBackendCommand = exactExternalBackendCommand(call, file, command)
      const commandResolved = command !== undefined && resolvedFlow(command, file, scope)
      const identity = declarationIdentity(call, file)
      if (!externalBackendCommand && !commandResolved) {
        if (!declarationAnalysis) throw fail(`unresolved child command: ${file}`)
        if (identity !== undefined) unresolvedDeclarations.add(identity)
      }
      const knownLaunchers = /^(?:node|nodejs|tsx|ts-node|bash|sh|zsh|npm|npm-cli|npx|pnpm|pnpx|yarn|yarnpkg)(?:\.cmd|\.exe)?$/
      const commandText = command?.getText(modules.get(file)?.sourceFile) ?? ""
      const interpreter = command !== undefined && (commandValues.some((value) => knownLaunchers.test(value.split(/[\\/]/).at(-1) ?? "")) || /process\.execPath/.test(commandText) || /^(?:["'`])?(?:node|nodejs|tsx|ts-node|bash|sh|zsh|npm|npx|pnpm|pnpx|yarn|yarnpkg)\b/.test(commandText))
      const sourceInterpreter = commandValues.some((value) => /^(?:node|nodejs|tsx|ts-node|bash|sh|zsh)(?:\.cmd|\.exe)?$/.test(value.split(/[\\/]/).at(-1) ?? "")) || /process\.execPath/.test(commandText)
      const expressions = api === "fork" || api === "exec" || api === "execSync"
        ? call.arguments.slice(0, 1)
        : sourceInterpreter ? call.arguments.slice(0, 2) : call.arguments.slice(0, 1)
      const argumentFlow = api === "exec" || api === "execSync" ? command : call.arguments[1]
      const argumentValues = argumentFlow === undefined ? [] : resolveValues(argumentFlow, file, scope)
      const values = expressions.flatMap((expression) => resolveValues(expression, file, scope))
      const resolved = [...new Set(values.flatMap((value) => {
        const target = normalizeTarget(file, value)
        return target === undefined ? [] : [target]
      }))]
      const untrackedSource = values.find((value) => sourceLikeTarget(value) && normalizeTarget(file, value) === undefined)
      if (untrackedSource !== undefined) throw fail(`untracked first-party launch target: ${file}: ${untrackedSource}`)
      const staticTarget = values.some((value) => sourceExtension.test(value) || value === "scripts/fixtures/job-control.sh")
      const inlineShell = commandValues.some((value) => /^(?:bash|sh|zsh)$/.test(value.split(/[\\/]/).at(-1) ?? "")) && argumentValues.includes("-c")
      const inlineNode = commandValues.some((value) => /^(?:node|nodejs)(?:\.exe)?$/.test(value.split(/[\\/]/).at(-1) ?? "")) && argumentValues.some((value) => /^(?:-e|--eval|--print)$/.test(value))
      const argumentResolved = argumentFlow === undefined || resolvedFlow(argumentFlow, file, scope)
      if (!declarationAnalysis && interpreter && resolved.length === 0 && !staticTarget && !inlineShell && !inlineNode && !argumentResolved) throw fail(`unresolved first-party launch target: ${file}`)
      if (declarationAnalysis && interpreter && resolved.length === 0 && !staticTarget && !inlineShell && !inlineNode && !argumentResolved && identity !== undefined) unresolvedDeclarations.add(identity)
      if (identity !== undefined && (!declarationAnalysis || scope.size > 0) && (externalBackendCommand || (commandResolved && (!interpreter || inlineShell || inlineNode || argumentResolved)))) provenDeclarations.add(identity)
      const independentlyResolved = !invokedHelper ? new Set<string>() : new Set(expressions.flatMap((expression) => resolveValues(expression, file, new Map())).flatMap((value) => {
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
    const helper = wrapper(call.expression, file, scope)
    if (helper === undefined) return
    const helperIdentity = `${helper.file}\0${helper.body.pos}`
    calledDeclarations.add(helperIdentity)
    if (invokedHelper && call.arguments.some((argument) => resolveValues(argument, file, new Map()).some((value) => normalizeTarget(file, value) !== undefined))) return
    const key = helperIdentity
    if (stack.has(key)) return
    const bindings = bindParameters(helper, [...call.arguments], file, scope, helper.scope)
    if (ts.isFunctionLike(helper.body)) return
    const visitHelper = (astNode: ts.Node) => {
      if (astNode !== helper.body && ts.isFunctionLike(astNode) && !ts.isCallExpression(astNode.parent)) return
      if (ts.isCallExpression(astNode)) inspectCall(astNode, helper.file, bindings, position, new Set([...stack, key]), observationCaller, declarationAnalysis, true)
      ts.forEachChild(astNode, visitHelper)
    }
    visitHelper(helper.body)
  }
  for (const [file, module] of modules) {
    const insideWrapper = (node: ts.Node) => ts.findAncestor(node, (ancestor) => ts.isFunctionLike(ancestor)) !== undefined
    const visit = (astNode: ts.Node) => {
      if (ts.isCallExpression(astNode)) inspectCall(astNode, file, new Map(), astNode.getStart(module.sourceFile), new Set(), file, insideWrapper(astNode))
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
  const unresolved = [...unresolvedDeclarations].find((identity) => !provenDeclarations.has(identity) && !calledDeclarations.has(identity))
  if (unresolved !== undefined) throw fail(`unresolved child command: ${unresolved.split("\0")[0]}`)
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
    const shebangFiles = new Set<string>()
    for (const file of trackedFiles.filter((file) => trackedModes.get(file)?.startsWith("100") === true)) {
      const prefix = yield* Effect.scoped(Effect.gen(function*() {
        const handle = yield* fs.open(path.join(root, file), { flag: "r" })
        const bytes = yield* handle.readAlloc(2)
        return Option.isSome(bytes) ? bytes.value : new Uint8Array()
      })).pipe(Effect.mapError((cause) => fail(`cannot inspect ${file}`, cause)))
      if (prefix[0] === 35 && prefix[1] === 33) shebangFiles.add(file)
    }
    const sources = new Map<string, string>()
    for (const file of trackedFiles.filter((file) => sourceExtension.test(file) || file.endsWith(".sh") || file.startsWith(".githooks/"))) {
      sources.set(file, yield* fs.readFileString(path.join(root, file)).pipe(Effect.mapError((cause) => fail(`cannot read ${file}`, cause))))
    }
    const parsedSources = new Map<string, ts.SourceFile>()
    for (const [file, source] of sources) {
      if (sourceExtension.test(file)) parsedSources.set(file, parseSource(file, source))
    }
    const checker = createTypeChecker(parsedSources)
    const parsedRunners = new Map<string, ReadonlyArray<ParsedRunner>>()
    for (const [file, parsed] of parsedSources) parsedRunners.set(file, parseRunners(parsed, checker))
    const registeredRunners = effectHostBoundaries.filter((boundary) => tracked.has(boundary.file) && boundary.construct.startsWith("runner:"))
    const runnerBoundaries = new Map<string, BoundaryLink>()
    for (const [file, runners] of parsedRunners) {
      if (runners.length > 1) return yield* fail(`multiple module runners discovered: ${file}`)
      for (const runner of runners) {
        const matches = registeredRunners.filter((boundary) => boundary.file === file && boundary.declaration === declarationKey(runner.declaration) && boundary.construct === runner.construct && boundary.occurrence === runner.occurrence)
        if (matches.length !== 1) return yield* fail(`unregistered or ambiguous module runner: ${file}`)
        if (runner.declaration.kind === "module") runnerBoundaries.set(file, runner)
      }
    }
    for (const boundary of registeredRunners.filter(({ declaration }) => declaration === "module:<module>")) {
      const parsed = parsedRunners.get(boundary.file) ?? []
      if (!parsed.some((runner) => declarationKey(runner.declaration) === boundary.declaration && runner.construct === boundary.construct && runner.occurrence === boundary.occurrence)) {
        return yield* fail(`registered module runner is stale: ${boundary.file}`)
      }
    }

    const childDiscovery = yield* Effect.try({
      try: () => discoverChildTargets(parsedSources, tracked, checker),
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

    const selectedHosts = trackedFiles.filter((file) => trackedModes.get(file) === "100755" || shebangFiles.has(file)).sort(compareText)
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
      const moduleRunners = runners.filter(({ declaration }) => declaration.kind === "module")
      for (const runner of moduleRunners) add(file, { file, selector: runner.construct, occurrence: runner.occurrence })
      if (moduleRunners.length === 1 && file.startsWith("examples/") && !file.includes("/test/")) add(file, { file, selector: "example-entry", occurrence: 0 })
      if (moduleRunners.length === 1 && file.startsWith("bench/")) add(file, { file, selector: "benchmark-entry", occurrence: 0 })
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
    const files = [...new Set(observations.map(({ file }) => file))].sort(compareText)
    const canonical = files.flatMap((file) => observations.filter((observation) => observation.file === file))
    return {
      observations: canonical,
      trackedFiles: [...trackedFiles].sort(compareText),
      trackedModes,
      sourceHashes,
      entrypointCount: files.length
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
