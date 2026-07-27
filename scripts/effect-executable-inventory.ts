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
      const architectureGate = entrypoint.file === "test/architecture/effect-candidate-inventory.test.ts"
        || entrypoint.file === "test/architecture/effect-executable-inventory.test.ts"
      const runnerRequired = entrypoint.kind === "effect-entrypoint" && sourceExtension.test(entrypoint.file) && !architectureGate
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
  bin: Schema.optionalKey(Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.String)])),
  main: Schema.optionalKey(Schema.String),
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
  ts.isIdentifier(node) && ts.isShorthandPropertyAssignment(node.parent)
    ? checker.getShorthandAssignmentValueSymbol(node.parent)?.declarations?.[0]
    : checker.getSymbolAtLocation(node)?.declarations?.[0]

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
  readonly namespaceExports: ReadonlyMap<string, ReadonlyArray<string>>
  readonly starExports: ReadonlyArray<string>
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
    const namespaceExports = new Map<string, Array<string>>()
    const starExports: Array<string> = []
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
      if (ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined && ts.isStringLiteralLike(statement.moduleSpecifier) && statement.exportClause === undefined) {
        const exportedFile = resolveSourceImport(file, statement.moduleSpecifier.text, tracked)
        if (exportedFile !== undefined) starExports.push(exportedFile)
      }
      if (ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined && ts.isStringLiteralLike(statement.moduleSpecifier) && statement.exportClause !== undefined && ts.isNamespaceExport(statement.exportClause)) {
        const exportedFile = resolveSourceImport(file, statement.moduleSpecifier.text, tracked)
        if (exportedFile !== undefined) {
          const existing = namespaceExports.get(statement.exportClause.name.text) ?? []
          existing.push(exportedFile)
          namespaceExports.set(statement.exportClause.name.text, existing)
        }
      }
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
          const dynamicImport = declaration.initializer === undefined
            ? undefined
            : ts.isAwaitExpression(declaration.initializer)
              ? declaration.initializer.expression
              : declaration.initializer
          if (dynamicImport !== undefined && ts.isCallExpression(dynamicImport) && dynamicImport.expression.kind === ts.SyntaxKind.ImportKeyword) {
            const specifier = dynamicImport.arguments[0]
            if (specifier === undefined || !ts.isStringLiteralLike(specifier)) throw fail(`unresolved first-party callable: dynamic module specifier: ${file}`)
            const importedFile = resolveSourceImport(file, specifier.text, tracked)
            if (importedFile !== undefined) {
              if (ts.isIdentifier(declaration.name)) imports.set(declaration.name.text, { file: importedFile, imported: "*" })
              if (ts.isObjectBindingPattern(declaration.name)) {
                for (const element of declaration.name.elements) {
                  if (ts.isIdentifier(element.name)) imports.set(element.name.text, { file: importedFile, imported: element.propertyName?.getText(sourceFile) ?? element.name.text })
                }
              }
            }
          }
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
      if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
        let initializer = node.initializer
        while (ts.isAwaitExpression(initializer) || ts.isParenthesizedExpression(initializer) || ts.isAsExpression(initializer) || ts.isTypeAssertionExpression(initializer) || ts.isSatisfiesExpression(initializer)) initializer = initializer.expression
        if (ts.isCallExpression(initializer) && initializer.expression.kind === ts.SyntaxKind.ImportKeyword && (initializer.arguments[0] === undefined || !ts.isStringLiteralLike(initializer.arguments[0]))) {
          throw fail(`unresolved first-party callable: dynamic module specifier: ${file}`)
        }
      }
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
    modules.set(file, { file, sourceFile, constants, imports, reExports, namespaceExports, starExports, launchers, namespaces, wrappers, wrapperDeclarations })
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
  const resolveNamespaceExport = (file: string, name: string, seen = new Set<string>()): string | undefined => {
    const key = `${file}\0namespace:${name}`
    if (seen.has(key)) throw fail(`unresolved first-party launch: cyclic namespace export flow: ${file}`)
    const nextSeen = new Set([...seen, key])
    const module = modules.get(file)
    const candidates = [...module?.namespaceExports.get(name) ?? []]
    let cyclic = false
    const gather = (exportedFile: string, exportedName: string) => {
      try {
        const candidate = resolveNamespaceExport(exportedFile, exportedName, nextSeen)
        if (candidate !== undefined) candidates.push(candidate)
      } catch (cause) {
        if (cause instanceof ExecutableInventoryError && cause.detail.includes("cyclic namespace export flow")) cyclic = true
        else throw cause
      }
    }
    const reExport = module?.reExports.get(name)
    if (reExport !== undefined) gather(reExport.file, reExport.imported)
    for (const exportedFile of module?.starExports ?? []) gather(exportedFile, name)
    const unique = [...new Set(candidates)]
    if (unique.length > 1) throw fail(`unresolved first-party launch: ambiguous namespace export flow: ${file}`)
    if (cyclic) throw fail(`unresolved first-party launch: cyclic namespace export flow: ${file}`)
    return unique[0]
  }
  const dynamicImportTarget = (expression: ts.Expression, file: string): string | undefined => {
    let current = expression
    while (ts.isAwaitExpression(current) || ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current) || ts.isSatisfiesExpression(current)) current = current.expression
    if (!ts.isCallExpression(current) || current.expression.kind !== ts.SyntaxKind.ImportKeyword) return undefined
    const specifier = current.arguments[0]
    if (specifier === undefined || !ts.isStringLiteralLike(specifier)) throw fail(`unresolved first-party callable: dynamic module specifier: ${file}`)
    return resolveSourceImport(file, specifier.text, tracked)
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
      if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
        const member = ts.isPropertyAccessExpression(expression)
          ? expression.name.text
          : expression.argumentExpression !== undefined && ts.isStringLiteralLike(expression.argumentExpression)
            ? expression.argumentExpression.text
            : undefined
        if (member === undefined || !ts.isIdentifier(expression.expression)) return undefined
        const declaration = symbolDeclaration(checker, expression.expression)
        if (declaration === undefined || declarations.has(declaration) || !ts.isNamespaceImport(declaration)) return undefined
        const imported = module?.imports.get(expression.expression.text)
        return imported === undefined ? undefined : resolveExportWrapper(imported.file, member, nextSeen)
      }
      if (!ts.isIdentifier(expression)) return undefined
      const declaration = symbolDeclaration(checker, expression)
      if (declaration === undefined || declarations.has(declaration)) return undefined
      const declaredWrapper = module?.wrapperDeclarations.get(declaration)
      if (declaredWrapper !== undefined) return declaredWrapper
      if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) return resolveExpression(declaration.initializer, new Set([...declarations, declaration]))
      if (ts.isImportSpecifier(declaration) || ts.isImportClause(declaration) || ts.isImportEqualsDeclaration(declaration)) {
        const imported = module?.imports.get(expression.text)
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
    if (reExport !== undefined) return resolveExportWrapper(reExport.file, reExport.imported, nextSeen)
    const candidates: Array<WrapperBinding> = []
    let cyclic = false
    for (const exportedFile of module?.starExports ?? []) {
      try {
        const candidate = resolveExportWrapper(exportedFile, name, nextSeen)
        if (candidate !== undefined && !candidates.some((existing) => existing.file === candidate.file && existing.body.pos === candidate.body.pos)) candidates.push(candidate)
      } catch (cause) {
        if (cause instanceof ExecutableInventoryError && cause.detail.includes("cyclic callable export flow")) cyclic = true
        else throw cause
      }
    }
    if (candidates.length > 1) throw fail(`unresolved first-party launch: ambiguous export-star callable flow: ${file}`)
    if (candidates.length === 1) return candidates[0]
    if (cyclic) throw fail(`unresolved first-party launch: cyclic callable export flow: ${file}`)
    return undefined
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
    const namespaceFile = (candidate: ts.Expression, declarations = new Set<ts.Declaration>()): string | undefined => {
      const direct = dynamicImportTarget(candidate, file)
      if (direct !== undefined) return direct
      if (!ts.isIdentifier(candidate)) return undefined
      const declaration = symbolDeclaration(checker, candidate)
      if (declaration === undefined || declarations.has(declaration)) return undefined
      const nextDeclarations = new Set([...declarations, declaration])
      if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) return namespaceFile(declaration.initializer, nextDeclarations)
      if (ts.isImportSpecifier(declaration) || ts.isImportClause(declaration) || ts.isImportEqualsDeclaration(declaration) || ts.isNamespaceImport(declaration)) {
        const imported = module?.imports.get(candidate.text)
        if (imported === undefined) return undefined
        if (imported.imported === "*") return imported.file
        return resolveNamespaceExport(imported.file, imported.imported)
      }
      return undefined
    }
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
      if (ts.isBindingElement(resolvedDeclaration) && ts.isObjectBindingPattern(resolvedDeclaration.parent)) {
        const variable = resolvedDeclaration.parent.parent
        const importedFile = ts.isVariableDeclaration(variable) && variable.initializer !== undefined ? namespaceFile(variable.initializer) : undefined
        const imported = resolvedDeclaration.propertyName?.getText(module?.sourceFile) ?? resolvedDeclaration.name.getText(module?.sourceFile)
        if (importedFile !== undefined) {
          const importedWrapper = resolveExportWrapper(importedFile, imported)
          if (importedWrapper !== undefined) return { ...importedWrapper, scope: new Map() }
        }
      }
      if (ts.isVariableDeclaration(resolvedDeclaration) && resolvedDeclaration.initializer !== undefined) return wrapper(resolvedDeclaration.initializer, file, scope, nextSeen)
    }
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      const owner = expression.expression
      const member = ts.isPropertyAccessExpression(expression)
        ? expression.name.text
        : expression.argumentExpression !== undefined && ts.isStringLiteralLike(expression.argumentExpression)
          ? expression.argumentExpression.text
          : undefined
      if (member !== undefined) {
        const importedFile = namespaceFile(owner)
        if (importedFile !== undefined) {
          const importedWrapper = resolveExportWrapper(importedFile, member)
          if (importedWrapper !== undefined) return { ...importedWrapper, scope: new Map() }
        }
      }
      return undefined
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
    if (helper === undefined) {
      const callableFromDynamicImport = (expression: ts.Expression, seen = new Set<ts.Declaration>()): boolean => {
        if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) return callableFromDynamicImport(expression.expression, seen)
        if (ts.isConditionalExpression(expression)) return callableFromDynamicImport(expression.whenTrue, seen) || callableFromDynamicImport(expression.whenFalse, seen)
        if (!ts.isIdentifier(expression)) return false
        const declaration = localBinding(expression)
        if (declaration === undefined || seen.has(declaration)) return false
        const nextSeen = new Set([...seen, declaration])
        if (ts.isBindingElement(declaration)) {
          const variable = declaration.parent.parent
          return ts.isVariableDeclaration(variable) && variable.initializer !== undefined && callableFromDynamicImport(variable.initializer, nextSeen)
        }
        if (!ts.isVariableDeclaration(declaration) || declaration.initializer === undefined) return false
        const initializer = ts.isAwaitExpression(declaration.initializer) ? declaration.initializer.expression : declaration.initializer
        if (ts.isCallExpression(initializer) && initializer.expression.kind === ts.SyntaxKind.ImportKeyword) return true
        return callableFromDynamicImport(initializer, nextSeen)
      }
      if (callableFromDynamicImport(call.expression)) throw fail(`unresolved first-party callable: ${file}`)
      return
    }
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
  const shellLauncher = (token: string) => /^(?:sh|bash|zsh)(?:\.exe)?$/.test(token.split(/[\\/]/).at(-1) ?? "")
  for (let index = 0; index < tokens.length; index += 1) {
    let launcher = tokens[index]!
    let launcherIndex = index
    if (/^(?:env)(?:\.exe)?$/.test(launcher.split(/[\\/]/).at(-1) ?? "")) {
      launcherIndex += 1
      while (tokens[launcherIndex]?.startsWith("-") === true || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[launcherIndex] ?? "")) launcherIndex += 1
      launcher = tokens[launcherIndex] ?? ""
    }
    if (shellLauncher(launcher)) {
      let targetIndex = launcherIndex + 1
      while (tokens[targetIndex]?.startsWith("-") === true && tokens[targetIndex] !== "-c") targetIndex += 1
      const target = tokens[targetIndex]
      if (target === undefined || isOperator(target) || target === "-c" || /[$`]/.test(target)) throw fail("unresolved shell executable target in manifest command")
      targets.push(target.replace(/[;,]$/, ""))
      index = launcherIndex
      continue
    }
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

const unwrapExpression = (expression: ts.Expression): ts.Expression =>
  ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isParenthesizedExpression(expression)
    ? unwrapExpression(expression.expression)
    : expression

const staticStrings = (expression: ts.Expression, checker: ts.TypeChecker, seen = new Set<ts.Declaration>()): ReadonlyArray<string> | undefined => {
  const unwrapped = unwrapExpression(expression)
  if (ts.isStringLiteralLike(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) return [unwrapped.text]
  if (ts.isArrayLiteralExpression(unwrapped)) {
    const values: Array<string> = []
    for (const element of unwrapped.elements) {
      if (!ts.isExpression(element)) return undefined
      const resolved = staticStrings(element, checker, seen)
      if (resolved === undefined) return undefined
      values.push(...resolved)
    }
    return values
  }
  if (ts.isCallExpression(unwrapped) && (ts.isPropertyAccessExpression(unwrapped.expression) || ts.isElementAccessExpression(unwrapped.expression))) {
    const member = ts.isPropertyAccessExpression(unwrapped.expression) ? unwrapped.expression.name.text : unwrapped.expression.argumentExpression !== undefined && ts.isStringLiteralLike(unwrapped.expression.argumentExpression) ? unwrapped.expression.argumentExpression.text : undefined
    const last = unwrapped.arguments.at(-1)
    if (/^(?:join|resolve)$/.test(member ?? "") && last !== undefined) return staticStrings(last, checker, seen)
  }
  if (!ts.isIdentifier(unwrapped)) return undefined
  const declaration = symbolDeclaration(checker, unwrapped)
  if (declaration === undefined || seen.has(declaration)) return undefined
  const nextSeen = new Set([...seen, declaration])
  if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) return staticStrings(declaration.initializer, checker, nextSeen)
  if (ts.isParameter(declaration)) {
    const owner = declaration.parent
    const parameterIndex = owner.parameters.indexOf(declaration)
    if (parameterIndex < 0) return undefined
    const ownerName = ts.isFunctionDeclaration(owner) || ts.isFunctionExpression(owner) ? owner.name : ts.isArrowFunction(owner) && ts.isVariableDeclaration(owner.parent) ? owner.parent.name : undefined
    if (ownerName === undefined) return undefined
    const ownerSymbol = checker.getSymbolAtLocation(ownerName)
    const sourceFile = owner.getSourceFile()
    const values: Array<string> = []
    let found = false
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && checker.getSymbolAtLocation(node.expression) === ownerSymbol) {
        found = true
        const argument = node.arguments[parameterIndex]
        const resolved = argument === undefined ? undefined : staticStrings(argument, checker, nextSeen)
        if (resolved !== undefined) values.push(...resolved)
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    return found && values.length > 0 ? values : undefined
  }
  if (ts.isBindingElement(declaration) && ts.isArrayBindingPattern(declaration.parent)) {
    const index = declaration.parent.elements.indexOf(declaration)
    const variable = declaration.parent.parent
    const loop = variable.parent.parent
    if (index < 0 || !ts.isForOfStatement(loop)) return undefined
    const collectionExpression = unwrapExpression(loop.expression)
    const collectionDeclaration = ts.isIdentifier(collectionExpression) ? symbolDeclaration(checker, collectionExpression) : undefined
    let initializer: ts.Expression = collectionExpression
    if (collectionDeclaration !== undefined && ts.isVariableDeclaration(collectionDeclaration)) {
      if (collectionDeclaration.initializer === undefined) return undefined
      initializer = collectionDeclaration.initializer
    }
    const array = unwrapExpression(initializer)
    if (!ts.isArrayLiteralExpression(array)) return undefined
    const values: Array<string> = []
    for (const element of array.elements) {
      const tuple = ts.isExpression(element) ? unwrapExpression(element) : undefined
      const selected = tuple !== undefined && ts.isArrayLiteralExpression(tuple) ? tuple.elements[index] : undefined
      if (selected === undefined || !ts.isExpression(selected)) return undefined
      const resolved = staticStrings(selected, checker, nextSeen)
      if (resolved === undefined) return undefined
      values.push(...resolved)
    }
    return values
  }
  return undefined
}

const propertyName = (name: ts.PropertyName, sourceFile: ts.SourceFile) => ts.isIdentifier(name) || ts.isStringLiteralLike(name)
  ? name.text
  : name.getText(sourceFile)

const staticObjectProperties = (
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Declaration>()
): ReadonlyMap<string, ts.Expression> | undefined => {
  const unwrapped = unwrapExpression(expression)
  if (ts.isIdentifier(unwrapped)) {
    const declaration = symbolDeclaration(checker, unwrapped)
    if (declaration === undefined || seen.has(declaration) || !ts.isVariableDeclaration(declaration) || declaration.initializer === undefined) return undefined
    return staticObjectProperties(declaration.initializer, checker, new Set([...seen, declaration]))
  }
  if (ts.isCallExpression(unwrapped)) {
    const callable = unwrapExpression(unwrapped.expression)
    if (ts.isArrowFunction(callable) || ts.isFunctionExpression(callable)) {
      const body = callable.body
      if (ts.isExpression(body)) return staticObjectProperties(body, checker, seen)
      const returns: Array<ts.Expression> = []
      const visit = (node: ts.Node) => {
        if (node !== body && ts.isFunctionLike(node)) return
        if (ts.isReturnStatement(node) && node.expression !== undefined) returns.push(node.expression)
        else ts.forEachChild(node, visit)
      }
      visit(body)
      return returns.length === 1 ? staticObjectProperties(returns[0]!, checker, seen) : undefined
    }
    if (!ts.isIdentifier(callable)) return undefined
    const declaration = symbolDeclaration(checker, callable)
    const importDeclaration = declaration === undefined ? undefined : ts.findAncestor(declaration, ts.isImportDeclaration)
    const imported = declaration !== undefined && ts.isImportSpecifier(declaration) ? declaration.propertyName?.text ?? declaration.name.text : undefined
    const isElectronConfig = imported === "defineConfig" && importDeclaration !== undefined && ts.isStringLiteralLike(importDeclaration.moduleSpecifier) && importDeclaration.moduleSpecifier.text === "electron-vite"
    return !isElectronConfig || unwrapped.arguments[0] === undefined ? undefined : staticObjectProperties(unwrapped.arguments[0], checker, seen)
  }
  if (!ts.isObjectLiteralExpression(unwrapped)) return undefined
  const properties = new Map<string, ts.Expression>()
  for (const property of unwrapped.properties) {
    if (ts.isSpreadAssignment(property)) {
      const spread = staticObjectProperties(property.expression, checker, seen)
      if (spread === undefined) return undefined
      for (const [name, value] of spread) properties.set(name, value)
      continue
    }
    if (ts.isPropertyAssignment(property)) {
      const name = propertyName(property.name, property.getSourceFile())
      properties.set(name, property.initializer)
      continue
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      properties.set(property.name.text, property.name)
      continue
    }
    return undefined
  }
  return properties
}

type EsbuildApi = "build" | "buildSync" | "context"
type EsbuildBinding = EsbuildApi | "namespace"

const esbuildBinding = (expression: ts.Expression, checker: ts.TypeChecker, seen = new Set<ts.Declaration>()): EsbuildBinding | undefined => {
  const unwrapped = unwrapExpression(expression)
  if (ts.isCallExpression(unwrapped)) {
    const callable = unwrapExpression(unwrapped.expression)
    const specifier = unwrapped.arguments[0]
    return ts.isIdentifier(callable) && callable.text === "require" && symbolDeclaration(checker, callable) === undefined && specifier !== undefined && ts.isStringLiteralLike(specifier) && specifier.text === "esbuild"
      ? "namespace"
      : undefined
  }
  if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
    const member = ts.isPropertyAccessExpression(unwrapped)
      ? unwrapped.name.text
      : unwrapped.argumentExpression !== undefined && ts.isStringLiteralLike(unwrapped.argumentExpression)
        ? unwrapped.argumentExpression.text
        : undefined
    return /^(?:build|buildSync|context)$/.test(member ?? "") && esbuildBinding(unwrapped.expression, checker, seen) === "namespace" ? member as EsbuildApi : undefined
  }
  if (!ts.isIdentifier(unwrapped)) return undefined
  const declaration = symbolDeclaration(checker, unwrapped)
  if (declaration === undefined || seen.has(declaration)) return undefined
  const nextSeen = new Set([...seen, declaration])
  const importDeclaration = ts.findAncestor(declaration, ts.isImportDeclaration)
  if (importDeclaration !== undefined && ts.isStringLiteralLike(importDeclaration.moduleSpecifier) && importDeclaration.moduleSpecifier.text === "esbuild") {
    if (ts.isNamespaceImport(declaration) || ts.isImportClause(declaration)) return "namespace"
    if (ts.isImportSpecifier(declaration)) {
      const imported = declaration.propertyName?.text ?? declaration.name.text
      return /^(?:build|buildSync|context)$/.test(imported) ? imported as EsbuildApi : undefined
    }
  }
  if (ts.isImportEqualsDeclaration(declaration) && ts.isExternalModuleReference(declaration.moduleReference) && declaration.moduleReference.expression !== undefined && ts.isStringLiteralLike(declaration.moduleReference.expression) && declaration.moduleReference.expression.text === "esbuild") return "namespace"
  if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) return esbuildBinding(declaration.initializer, checker, nextSeen)
  if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)) {
    const variable = declaration.parent.parent
    if (!ts.isVariableDeclaration(variable) || variable.initializer === undefined) return undefined
    const member = declaration.propertyName?.getText(declaration.getSourceFile()) ?? declaration.name.getText(declaration.getSourceFile())
    return /^(?:build|buildSync|context)$/.test(member) && esbuildBinding(variable.initializer, checker, nextSeen) === "namespace" ? member as EsbuildApi : undefined
  }
  return undefined
}

const esbuildApi = (expression: ts.Expression, checker: ts.TypeChecker): EsbuildApi | undefined => {
  const binding = esbuildBinding(expression, checker)
  return binding === "namespace" ? undefined : binding
}

const esbuildEntryPoints = (
  expression: ts.Expression,
  checker: ts.TypeChecker,
  sourceFiles: ReadonlyArray<ts.SourceFile>
): ReadonlyArray<string> | undefined => {
  const sourceMap = new Map(sourceFiles.map((sourceFile) => [sourceFile.fileName, sourceFile]))
  const sourcePaths = new Set(sourceMap.keys())
  let callableFunction: (candidate: ts.Expression, seen?: Set<ts.Declaration>) => ts.FunctionLikeDeclaration | undefined
  const exportedFunction = (file: string, name: string, seen = new Set<string>()): ts.FunctionLikeDeclaration | undefined => {
    const key = `${file}\0${name}`
    if (seen.has(key)) return undefined
    const sourceFile = sourceMap.get(file)
    if (sourceFile === undefined) return undefined
    const nextSeen = new Set([...seen, key])
    const local = (localName: string) => {
      for (const statement of sourceFile.statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name?.text === localName) return statement
        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name) && declaration.name.text === localName && declaration.initializer !== undefined) {
              const resolved = callableFunction(declaration.initializer)
              if (resolved !== undefined) return resolved
            }
          }
        }
      }
      return undefined
    }
    const candidates: Array<ts.FunctionLikeDeclaration> = []
    const add = (candidate: ts.FunctionLikeDeclaration | undefined) => {
      if (candidate !== undefined && !candidates.includes(candidate)) candidates.push(candidate)
    }
    for (const statement of sourceFile.statements) {
      const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined
      const exported = modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword) === true
      const defaulted = modifiers?.some(({ kind }) => kind === ts.SyntaxKind.DefaultKeyword) === true
      if (exported && ts.isFunctionDeclaration(statement) && ((defaulted && name === "default") || statement.name?.text === name)) add(statement)
      if (exported && ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer !== undefined) add(callableFunction(declaration.initializer))
        }
      }
      if (name === "default" && ts.isExportAssignment(statement) && !statement.isExportEquals) add(callableFunction(statement.expression))
      if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          if (element.name.text !== name) continue
          const imported = element.propertyName?.text ?? element.name.text
          if (statement.moduleSpecifier === undefined) add(local(imported))
          else if (ts.isStringLiteralLike(statement.moduleSpecifier)) {
            const importedFile = resolveSourceImport(file, statement.moduleSpecifier.text, sourcePaths)
            if (importedFile !== undefined) add(exportedFunction(importedFile, imported, nextSeen))
          }
        }
      }
      if (ts.isExportDeclaration(statement) && statement.exportClause === undefined && statement.moduleSpecifier !== undefined && ts.isStringLiteralLike(statement.moduleSpecifier)) {
        const importedFile = resolveSourceImport(file, statement.moduleSpecifier.text, sourcePaths)
        if (importedFile !== undefined) add(exportedFunction(importedFile, name, nextSeen))
      }
    }
    return candidates.length === 1 ? candidates[0] : undefined
  }
  callableFunction = (candidate: ts.Expression, seen = new Set<ts.Declaration>()): ts.FunctionLikeDeclaration | undefined => {
    const unwrapped = unwrapExpression(candidate)
    if (ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped)) return unwrapped
    if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
      const owner = unwrapExpression(unwrapped.expression)
      const member = ts.isPropertyAccessExpression(unwrapped) ? unwrapped.name.text : unwrapped.argumentExpression !== undefined && ts.isStringLiteralLike(unwrapped.argumentExpression) ? unwrapped.argumentExpression.text : undefined
      const ownerDeclaration = ts.isIdentifier(owner) ? symbolDeclaration(checker, owner) : undefined
      const importDeclaration = ownerDeclaration !== undefined && ts.isNamespaceImport(ownerDeclaration) ? ts.findAncestor(ownerDeclaration, ts.isImportDeclaration) : undefined
      if (member !== undefined && importDeclaration !== undefined && ts.isStringLiteralLike(importDeclaration.moduleSpecifier)) {
        const importedFile = resolveSourceImport(unwrapped.getSourceFile().fileName, importDeclaration.moduleSpecifier.text, sourcePaths)
        if (importedFile !== undefined) return exportedFunction(importedFile, member)
      }
    }
    const symbolNode = ts.isIdentifier(unwrapped)
      ? unwrapped
      : ts.isPropertyAccessExpression(unwrapped)
        ? unwrapped.name
        : ts.isElementAccessExpression(unwrapped) && unwrapped.argumentExpression !== undefined
          ? unwrapped.argumentExpression
          : undefined
    if (symbolNode === undefined) return undefined
    const declaration = symbolDeclaration(checker, symbolNode)
    if (declaration === undefined || seen.has(declaration)) return undefined
    const nextSeen = new Set([...seen, declaration])
    if (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) return declaration
    if (ts.isPropertyAssignment(declaration)) return callableFunction(declaration.initializer, nextSeen)
    if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) return callableFunction(declaration.initializer, nextSeen)
    if (ts.isImportSpecifier(declaration) || ts.isImportClause(declaration)) {
      const importDeclaration = ts.findAncestor(declaration, ts.isImportDeclaration)
      if (importDeclaration === undefined || !ts.isStringLiteralLike(importDeclaration.moduleSpecifier)) return undefined
      const importedFile = resolveSourceImport(unwrapped.getSourceFile().fileName, importDeclaration.moduleSpecifier.text, sourcePaths)
      const imported = ts.isImportSpecifier(declaration) ? declaration.propertyName?.text ?? declaration.name.text : "default"
      return importedFile === undefined ? undefined : exportedFunction(importedFile, imported)
    }
    return undefined
  }
  const interfaceMember = (typeNode: ts.TypeNode | undefined, member: string): ts.Declaration | undefined => {
    if (typeNode === undefined || !ts.isTypeReferenceNode(typeNode)) return undefined
    const declaration = symbolDeclaration(checker, typeNode.typeName)
    return declaration !== undefined && ts.isInterfaceDeclaration(declaration)
      ? declaration.members.find((candidate) => candidate.name !== undefined && propertyName(candidate.name, candidate.getSourceFile()) === member)
      : undefined
  }
  const propertyContract = (owner: ts.SignatureDeclaration): ts.Declaration | undefined => {
    const property = ts.findAncestor(owner, ts.isPropertyAssignment)
    if (property === undefined || wrappedFunction(property.initializer) !== owner) return undefined
    const object = property.parent
    const variable = ts.isObjectLiteralExpression(object) && ts.isVariableDeclaration(object.parent) ? object.parent : undefined
    return interfaceMember(variable?.type, propertyName(property.name, property.getSourceFile())) ?? property
  }
  const callContract = (expression: ts.Expression): ts.Declaration | undefined => {
    const unwrapped = unwrapExpression(expression)
    if (!ts.isPropertyAccessExpression(unwrapped) && !ts.isElementAccessExpression(unwrapped)) return undefined
    const memberNode = ts.isPropertyAccessExpression(unwrapped) ? unwrapped.name : unwrapped.argumentExpression
    const member = memberNode !== undefined && (ts.isIdentifier(memberNode) || ts.isStringLiteralLike(memberNode)) ? memberNode.text : undefined
    if (memberNode === undefined || member === undefined) return undefined
    const direct = symbolDeclaration(checker, memberNode)
    if (direct !== undefined) return direct
    const receiver = unwrapExpression(unwrapped.expression)
    if (!ts.isIdentifier(receiver)) return undefined
    const receiverDeclaration = symbolDeclaration(checker, receiver)
    const initializer = receiverDeclaration !== undefined && ts.isVariableDeclaration(receiverDeclaration) ? receiverDeclaration.initializer : undefined
    const service = initializer !== undefined && ts.isYieldExpression(initializer) && initializer.expression !== undefined ? unwrapExpression(initializer.expression) : undefined
    const serviceDeclaration = service !== undefined && ts.isIdentifier(service) ? symbolDeclaration(checker, service) : undefined
    if (serviceDeclaration === undefined || !ts.isClassDeclaration(serviceDeclaration)) return undefined
    let contract: ts.Declaration | undefined
    const visit = (node: ts.Node) => {
      if (contract !== undefined) return
      if (ts.isCallExpression(node)) {
        for (const typeArgument of node.typeArguments ?? []) {
          contract = interfaceMember(typeArgument, member)
          if (contract !== undefined) return
        }
      }
      ts.forEachChild(node, visit)
    }
    for (const clause of serviceDeclaration.heritageClauses ?? []) visit(clause)
    return contract
  }
  const callsOf = (owner: ts.SignatureDeclaration): ReadonlyArray<ts.CallExpression> => {
    const calls: Array<ts.CallExpression> = []
    const contract = propertyContract(owner)
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && (callableFunction(node.expression) === owner || (contract !== undefined && callContract(node.expression) === contract))) calls.push(node)
      ts.forEachChild(node, visit)
    }
    sourceFiles.forEach(visit)
    return calls
  }
  const parameterOwner = (declaration: ts.Declaration): { readonly parameter: ts.ParameterDeclaration; readonly owner: ts.SignatureDeclaration } | undefined => {
    const parameter = ts.isParameter(declaration) ? declaration : ts.findAncestor(declaration, ts.isParameter)
    return parameter === undefined || !ts.isFunctionLike(parameter.parent) ? undefined : { parameter, owner: parameter.parent }
  }
  const bindingExpressions = (declaration: ts.Declaration, seen: ReadonlySet<ts.Declaration>): ReadonlyArray<ts.Expression> | undefined => {
    const owned = parameterOwner(declaration)
    if (owned !== undefined) {
      const index = owned.owner.parameters.indexOf(owned.parameter)
      const calls = callsOf(owned.owner)
      if (index < 0 || calls.length === 0) return undefined
      let argumentsList = calls.map((call) => call.arguments[index]).filter((argument): argument is ts.Expression => argument !== undefined)
      if (argumentsList.length !== calls.length) return undefined
      if (ts.isBindingElement(declaration)) {
        const path: Array<string | number> = []
        let current: ts.BindingElement = declaration
        while (true) {
          const pattern = current.parent
          if (ts.isObjectBindingPattern(pattern)) path.unshift(current.propertyName?.getText(current.getSourceFile()) ?? current.name.getText(current.getSourceFile()))
          else if (ts.isArrayBindingPattern(pattern)) path.unshift(pattern.elements.indexOf(current))
          else return undefined
          if (!ts.isBindingElement(pattern.parent)) break
          current = pattern.parent
        }
        for (const segment of path) {
          const selected = argumentsList.map((argument) => {
            if (typeof segment === "string") return staticObjectProperties(argument, checker)?.get(segment)
            const array = unwrapExpression(argument)
            return ts.isArrayLiteralExpression(array) && array.elements[segment] !== undefined && ts.isExpression(array.elements[segment]!) ? array.elements[segment] as ts.Expression : undefined
          })
          if (!selected.every((value): value is ts.Expression => value !== undefined)) return undefined
          argumentsList = selected
        }
      }
      return argumentsList
    }
    if (ts.isBindingElement(declaration) && ts.isArrayBindingPattern(declaration.parent)) {
      const index = declaration.parent.elements.indexOf(declaration)
      const variable = declaration.parent.parent
      const loop = variable.parent.parent
      if (index < 0 || !ts.isForOfStatement(loop)) return undefined
      const collection = unwrapExpression(loop.expression)
      const collectionDeclaration = ts.isIdentifier(collection) ? symbolDeclaration(checker, collection) : undefined
      const initializer = collectionDeclaration !== undefined && ts.isVariableDeclaration(collectionDeclaration) && collectionDeclaration.initializer !== undefined
        ? unwrapExpression(collectionDeclaration.initializer)
        : collection
      if (!ts.isArrayLiteralExpression(initializer)) return undefined
      const selected: Array<ts.Expression> = []
      for (const element of initializer.elements) {
        const tuple = ts.isExpression(element) ? unwrapExpression(element) : undefined
        const value = tuple !== undefined && ts.isArrayLiteralExpression(tuple) ? tuple.elements[index] : undefined
        if (value === undefined || !ts.isExpression(value)) return undefined
        selected.push(value)
      }
      return selected
    }
    if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) return [declaration.initializer]
    return undefined
  }
  const resolveExpressions = (candidate: ts.Expression, seen = new Set<ts.Declaration>()): ReadonlyArray<ts.Expression> | undefined => {
    const unwrapped = unwrapExpression(candidate)
    if (ts.isIdentifier(unwrapped)) {
      const declaration = symbolDeclaration(checker, unwrapped)
      if (declaration === undefined || seen.has(declaration)) return undefined
      const expressions = bindingExpressions(declaration, seen)
      if (expressions === undefined) return undefined
      const nextSeen = new Set([...seen, declaration])
      const resolved = expressions.map((value) => resolveExpressions(value, nextSeen))
      return resolved.every((value): value is ReadonlyArray<ts.Expression> => value !== undefined) ? resolved.flat() : undefined
    }
    if (ts.isCallExpression(unwrapped)) {
      const owner = callableFunction(unwrapped.expression)
      if (owner === undefined || owner.body === undefined) return [unwrapped]
      const returns: Array<ts.Expression> = []
      if (ts.isExpression(owner.body)) returns.push(owner.body)
      else {
        const visit = (node: ts.Node) => {
          if (node !== owner.body && ts.isFunctionLike(node)) return
          if (ts.isReturnStatement(node) && node.expression !== undefined) returns.push(node.expression)
          else ts.forEachChild(node, visit)
        }
        visit(owner.body)
      }
      return returns.length === 1 ? resolveExpressions(returns[0]!, seen) : undefined
    }
    return [unwrapped]
  }
  const strings = (candidate: ts.Expression, seen = new Set<ts.Declaration>()): ReadonlyArray<string> | undefined => {
    const unwrapped = unwrapExpression(candidate)
    if (ts.isStringLiteralLike(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) return [unwrapped.text]
    if (ts.isTemplateExpression(unwrapped)) {
      const values = unwrapped.templateSpans.map((span) => strings(span.expression, seen))
      if (!values.every((value): value is ReadonlyArray<string> => value !== undefined && value.length === 1)) return undefined
      return [[unwrapped.head.text, ...unwrapped.templateSpans.flatMap((span, index) => [values[index]![0]!, span.literal.text])].join("")]
    }
    if (ts.isArrayLiteralExpression(unwrapped)) {
      const values = unwrapped.elements.map((element) => ts.isExpression(element) ? strings(element, seen) : undefined)
      return values.every((value): value is ReadonlyArray<string> => value !== undefined) ? values.flat() : undefined
    }
    if (ts.isCallExpression(unwrapped) && (ts.isPropertyAccessExpression(unwrapped.expression) || ts.isElementAccessExpression(unwrapped.expression))) {
      const member = ts.isPropertyAccessExpression(unwrapped.expression) ? unwrapped.expression.name.text : unwrapped.expression.argumentExpression !== undefined && ts.isStringLiteralLike(unwrapped.expression.argumentExpression) ? unwrapped.expression.argumentExpression.text : undefined
      const last = unwrapped.arguments.at(-1)
      return /^(?:join|resolve)$/.test(member ?? "") && last !== undefined ? strings(last, seen) : undefined
    }
    if (!ts.isIdentifier(unwrapped)) return undefined
    const declaration = symbolDeclaration(checker, unwrapped)
    if (declaration === undefined || seen.has(declaration)) return undefined
    const expressions = bindingExpressions(declaration, seen)
    if (expressions === undefined) return undefined
    const nextSeen = new Set([...seen, declaration])
    const values = expressions.map((value) => strings(value, nextSeen))
    return values.every((value): value is ReadonlyArray<string> => value !== undefined) ? values.flat() : undefined
  }
  const resolvedOptions = resolveExpressions(expression)
  if (resolvedOptions === undefined || resolvedOptions.length === 0) return undefined
  const inputs: Array<string> = []
  for (const option of resolvedOptions) {
    const properties = staticObjectProperties(option, checker)
    const entryPoints = properties?.get("entryPoints")
    if (entryPoints === undefined) return undefined
    const values = strings(entryPoints)
    if (values === undefined || values.length === 0) return undefined
    inputs.push(...values)
  }
  return inputs
}

const executableInput = (expression: ts.Expression, checker: ts.TypeChecker): string | undefined => {
  const unwrapped = unwrapExpression(expression)
  if (ts.isCallExpression(unwrapped)) {
    const last = unwrapped.arguments.at(-1)
    if (last === undefined) return undefined
    const values = staticStrings(last, checker)
    return values?.length === 1 ? values[0] : undefined
  }
  const values = staticStrings(unwrapped, checker)
  return values?.length === 1 ? values[0] : undefined
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
    const addParsedTarget = Effect.fn("ExecutableInventory.addParsedTarget")(function*(file: string, invocation: Invocation) {
      if (!validPath(file) || !tracked.has(file) || trackedModes.get(file)?.startsWith("100") !== true) {
        return yield* fail(`untracked executable target: ${invocation.file}: ${file}`)
      }
      add(file, invocation)
    })

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
      const directTargets = [
        ...(manifest.module === undefined ? [] : [{ selector: "manifest:module", target: manifest.module }]),
        ...(manifest.main === undefined ? [] : [{ selector: "manifest:main", target: manifest.main }]),
        ...(typeof manifest.bin === "string"
          ? [{ selector: "manifest:bin", target: manifest.bin }]
          : Object.entries(manifest.bin ?? {}).map(([name, target]) => ({ selector: `manifest:bin.${name}`, target })))
      ].map(({ selector, target }) => ({ selector, target: normalizeManifestPath(manifestFile, target) }))
        .filter(({ target }) => !/(?:^|\/)(?:dist|out)\//.test(target))
      for (const { selector, target } of directTargets) yield* addParsedTarget(target, { file: manifestFile, selector, occurrence: 0 })
      for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
        let occurrence = 0
        const candidates = yield* Effect.try({ try: () => manifestSourceTargets(command), catch: (cause) => cause instanceof ExecutableInventoryError ? cause : fail(`cannot parse manifest command: ${manifestFile}`, cause) })
        for (const candidate of candidates) {
          yield* addParsedTarget(normalizeManifestPath(manifestFile, candidate), { file: manifestFile, selector: `manifest:scripts.${name}`, occurrence: occurrence++ })
        }
      }
    }

    for (const [file, sourceFile] of parsedSources) {
      const occurrences = new Map<string, number>()
      const visitEsbuild = (node: ts.Node) => {
        if (ts.isCallExpression(node)) {
          const api = esbuildApi(node.expression, checker)
          if (api !== undefined) {
            const argument = node.arguments[0]
            const inputs = argument === undefined ? undefined : esbuildEntryPoints(argument, checker, [...parsedSources.values()])
            if (inputs === undefined || inputs.length === 0) throw fail(`unresolved executable input: ${file}:esbuild:${api}`)
            inputs.forEach((input) => {
              const occurrence = occurrences.get(api) ?? 0
              occurrences.set(api, occurrence + 1)
              if (!validPath(input) || !tracked.has(input) || trackedModes.get(input)?.startsWith("100") !== true) throw fail(`untracked executable target: ${file}: ${input}`)
              add(input, { file, selector: `esbuild:${api}`, occurrence })
            })
          }
        }
        ts.forEachChild(node, visitEsbuild)
      }
      yield* Effect.try({ try: () => visitEsbuild(sourceFile), catch: (cause) => cause instanceof ExecutableInventoryError ? cause : fail(`esbuild discovery failed: ${file}`, cause) })
    }

    if (tracked.has("apps/desktop/electron.vite.config.ts")) {
      const configFile = parsedSources.get("apps/desktop/electron.vite.config.ts")!
      const configChecker = createTypeChecker(new Map([["apps/desktop/electron.vite.config.ts", configFile]]))
      const exports = configFile.statements.filter(ts.isExportAssignment)
      if (exports.length !== 1 || exports[0]!.isExportEquals) return yield* fail("unresolved executable input: apps/desktop/electron.vite.config.ts")
      const config = staticObjectProperties(exports[0]!.expression, configChecker)
      if (config === undefined) return yield* fail("unresolved executable input: apps/desktop/electron.vite.config.ts")
      let configured = 0
      for (const section of ["main", "preload", "renderer"]) {
        const sectionExpression = config.get(section)
        if (sectionExpression === undefined) continue
        configured += 1
        const sectionProperties = staticObjectProperties(sectionExpression, configChecker)
        const buildExpression = sectionProperties?.get("build")
        const buildProperties = buildExpression === undefined ? undefined : staticObjectProperties(buildExpression, configChecker)
        const rollupExpression = buildProperties?.get("rollupOptions")
        const rollupProperties = rollupExpression === undefined ? undefined : staticObjectProperties(rollupExpression, configChecker)
        const inputExpression = rollupProperties?.get("input")
        const input = inputExpression === undefined ? undefined : executableInput(inputExpression, configChecker)
        if (input === undefined) return yield* fail(`unresolved executable input: apps/desktop/electron.vite.config.ts:${section}`)
        yield* addParsedTarget(normalizeManifestPath("apps/desktop/package.json", input), { file: "apps/desktop/electron.vite.config.ts", selector: `electron:${section}`, occurrence: 0 })
      }
      if (configured === 0) return yield* fail("unresolved executable input: apps/desktop/electron.vite.config.ts")
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
