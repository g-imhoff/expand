import * as ts from "typescript"
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

// Repo root = parent of scripts/. Same import.meta.url pattern the arch tests use,
// so it resolves correctly both under `bun run` and under vitest.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

// Fold nodes PER PROJECTION. Each projection's version is a hash of exactly its
// nodes, so a future projection's logic change never invalidates another
// projection's persisted state. Adding a projection = add a map entry.
// Over-capture is safe; under-capture (a real fold input not listed) is the only
// unsoundness — backed by the snapshot-equivalence oracle.
const PROJECTIONS: Readonly<Record<string, ReadonlyArray<{ readonly file: string; readonly name: string }>>> = {
  projects: [
    { file: "packages/contracts/project.ts", name: "Project" },          // class: fromCreated/applyEvent/foldList + read-model shape
    { file: "apps/server/domain/project.ts", name: "projectsFromEvents" } // the boot-rebuild copy of the fold
  ]
}

const findNamedNode = (src: ts.SourceFile, name: string): ts.Node | undefined => {
  for (const stmt of src.statements) {
    if ((ts.isClassDeclaration(stmt) || ts.isFunctionDeclaration(stmt)) && stmt.name?.text === name) {
      return stmt
    }
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === name) return stmt
      }
    }
  }
  return undefined
}

// removeComments + the printer's canonical formatting means comment/whitespace/
// reformatting edits do NOT change the hash; identifier/literal changes DO.
const printer = ts.createPrinter({ removeComments: true })

const hashNodes = (nodes: ReadonlyArray<{ readonly file: string; readonly name: string }>): string => {
  const hash = createHash("sha256")
  for (const { file, name } of nodes) {
    const path = join(ROOT, file)
    const src = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true)
    const node = findNamedNode(src, name)
    if (node === undefined) {
      throw new Error(`fold-version: node '${name}' not found in ${file} (did the fold move or get renamed?)`)
    }
    hash.update(`${file}::${name}\n`)
    hash.update(printer.printNode(ts.EmitHint.Unspecified, node, src))
    hash.update("\n \n")
  }
  return `sha256:${hash.digest("hex")}`
}

export const computeFoldHashes = (): Readonly<Record<string, string>> =>
  Object.fromEntries(Object.entries(PROJECTIONS).map(([name, nodes]) => [name, hashNodes(nodes)]))

const GENERATED_PATH = join(ROOT, "packages", "contracts", "fold-version.generated.ts")

const write = (): Readonly<Record<string, string>> => {
  const versions = computeFoldHashes()
  writeFileSync(
    GENERATED_PATH,
    `// GENERATED — do not edit by hand. Run \`bun run gen:fold-version\` after changing a fold.
// FOLD_VERSIONS maps projection name → hash of that projection's fold nodes
// (see scripts/fold-version.ts PROJECTIONS).
// Staleness is caught by test/architecture/fold-version-lockstep.test.ts.
export const FOLD_VERSIONS = ${JSON.stringify(versions, null, 2)} as const
`
  )
  return versions
}

if (import.meta.main) {
  const versions = write()
  console.log(`fold-version: wrote ${GENERATED_PATH}`)
  for (const [name, v] of Object.entries(versions)) console.log(`  ${name}: ${v}`)
}
