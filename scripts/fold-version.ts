import { NodeRuntime, NodeServices } from "@effect/platform-node"
import * as ts from "typescript"
import { Console, Crypto, Data, Effect, Encoding, FileSystem, Path } from "effect"

const PROJECTIONS: Readonly<Record<string, ReadonlyArray<{ readonly file: string; readonly name: string }>>> = {
  projects: [
    { file: "packages/contracts/project.ts", name: "Project" }
  ]
}

const printer = ts.createPrinter({ removeComments: true })
const textEncoder = new TextEncoder()

export class FoldVersionError extends Data.TaggedError("FoldVersionError")<{
  readonly reason: "read-failed" | "node-not-found" | "digest-failed" | "write-failed"
  readonly file: string
  readonly node?: string
  readonly cause?: unknown
}> {}

export const findNamedNode = (source: ts.SourceFile, name: string): ts.Node | undefined => {
  for (const statement of source.statements) {
    if ((ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement)) && statement.name?.text === name) {
      return statement
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return statement
      }
    }
  }
  return undefined
}

export const canonicalFoldSource = (
  file: string,
  name: string,
  sourceText: string
): string | undefined => {
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true)
  const node = findNamedNode(source, name)
  if (node === undefined) return undefined
  return `${file}::${name}\n${printer.printNode(ts.EmitHint.Unspecified, node, source)}\n \n`
}

const quoteString = (value: string): string => `"${value
  .replaceAll("\\", "\\\\")
  .replaceAll('"', '\\"')
  .replaceAll("\b", "\\b")
  .replaceAll("\f", "\\f")
  .replaceAll("\n", "\\n")
  .replaceAll("\r", "\\r")
  .replaceAll("\t", "\\t")}"`

export const renderFoldVersions = (versions: Readonly<Record<string, string>>): string => {
  const entries = Object.entries(versions)
    .map(([name, version]) => `  ${quoteString(name)}: ${quoteString(version)}`)
    .join(",\n")
  return `// GENERATED — do not edit by hand. Run \`npm run gen:fold-version\` after changing a fold.
// FOLD_VERSIONS maps projection name → hash of that projection's fold nodes
// (see scripts/fold-version.ts PROJECTIONS).
// Staleness is caught by test/architecture/fold-version-lockstep.test.ts.
export const FOLD_VERSIONS = {\n${entries}\n} as const
`
}

export const computeFoldHashes = Effect.fn("scripts.fold-version.computeFoldHashes")(
  function*(rootDir: string) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const crypto = yield* Crypto.Crypto
    const versions: Record<string, string> = {}

    for (const [projection, nodes] of Object.entries(PROJECTIONS)) {
      let canonical = ""
      for (const { file, name } of nodes) {
        const source = yield* fs.readFileString(path.join(rootDir, file)).pipe(
          Effect.mapError((cause) => new FoldVersionError({ reason: "read-failed", file, node: name, cause }))
        )
        const printed = canonicalFoldSource(file, name, source)
        if (printed === undefined) {
          return yield* new FoldVersionError({ reason: "node-not-found", file, node: name })
        }
        canonical += printed
      }
      const digest = yield* crypto.digest("SHA-256", textEncoder.encode(canonical)).pipe(
        Effect.mapError((cause) => new FoldVersionError({ reason: "digest-failed", file: projection, cause }))
      )
      versions[projection] = `sha256:${Encoding.encodeHex(digest)}`
    }

    return versions as Readonly<Record<string, string>>
  }
)

const writeFoldVersions = Effect.fn("scripts.fold-version.writeFoldVersions")(
  function*(rootDir: string) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const versions = yield* computeFoldHashes(rootDir)
    const generatedPath = path.join(rootDir, "packages", "contracts", "fold-version.generated.ts")
    yield* fs.writeFileString(generatedPath, renderFoldVersions(versions)).pipe(
      Effect.mapError((cause) => new FoldVersionError({ reason: "write-failed", file: generatedPath, cause }))
    )
    yield* Console.log(`fold-version: wrote ${generatedPath}`)
    for (const [name, version] of Object.entries(versions)) {
      yield* Console.log(`  ${name}: ${version}`)
    }
  }
)

const program = Effect.gen(function*() {
  const path = yield* Path.Path
  const root = yield* path.fromFileUrl(new URL("../", import.meta.url))
  yield* writeFoldVersions(root)
}).pipe(Effect.provide(NodeServices.layer))

if (import.meta.main) {
  NodeRuntime.runMain(program)
}
