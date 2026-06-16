import * as ts from "typescript"
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

// Repo root = parent of scripts/. Same import.meta.url pattern the arch tests use,
// so it resolves correctly both under `bun run` and under vitest.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

// The hardcoded list of fold nodes. FOLD_VERSION is a hash of EXACTLY these nodes,
// so it changes iff the projection fold changes. Adding a new projection = add its
// fold node here (one line). Over-capture is safe; under-capture (a real fold input
// not listed) is the only unsoundness — backed by the snapshot-equivalence oracle.
const FOLD_NODES: ReadonlyArray<{ readonly file: string; readonly name: string }> = [
  { file: "packages/contracts/project.ts", name: "Project" },          // class: fromCreated/applyEvent/foldList + read-model shape
  { file: "apps/server/domain/project.ts", name: "projectsFromEvents" } // the boot-rebuild copy of the fold
]

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

export const computeFoldHash = (): string => {
  const hash = createHash("sha256")
  for (const { file, name } of FOLD_NODES) {
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

const GENERATED_PATH = join(ROOT, "packages", "contracts", "fold-version.generated.ts")

const write = (): string => {
  const version = computeFoldHash()
  writeFileSync(
    GENERATED_PATH,
    `// GENERATED — do not edit by hand. Run \`bun run gen:fold-version\` after changing the fold.
// FOLD_VERSION is a hash of the projection fold nodes (see scripts/fold-version.ts FOLD_NODES).
// Staleness is caught by test/architecture/fold-version-lockstep.test.ts.
export const FOLD_VERSION = ${JSON.stringify(version)}
`
  )
  return version
}

if (import.meta.main) {
  const version = write()
  console.log(`fold-version: wrote ${GENERATED_PATH}\n  ${version}`)
}
