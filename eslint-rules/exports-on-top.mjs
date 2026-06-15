/**
 * Enforces the module-layout convention: exported declarations stay at the top
 * of the file; non-exported *type-level* plumbing (type aliases, interfaces)
 * lives below them.
 *
 * Scope is deliberately narrow — only non-exported `type`/`interface`
 * declarations are flagged. Non-exported *values* (const/function/class) are
 * left alone, because a value often MUST precede the export that consumes it
 * (temporal dead zone); forcing those below would be a runtime ReferenceError.
 * Type declarations are erased and position-independent, so they can always
 * move down safely.
 *
 * @type {import('eslint').Rule.RuleModule}
 */
export const exportsOnTop = {
  meta: {
    type: "layout",
    docs: {
      description:
        "Non-exported type aliases and interfaces must appear below all exported declarations"
    },
    schema: [],
    messages: {
      typeBeforeExport:
        "Non-exported {{kind}} '{{name}}' appears before an exported declaration. Move it below the exports (exports on top, type plumbing below)."
    }
  },
  create(context) {
    return {
      Program(program) {
        const body = program.body

        let lastExportIdx = -1
        for (let i = 0; i < body.length; i++) {
          if (isExport(body[i])) lastExportIdx = i
        }
        if (lastExportIdx === -1) return

        for (let i = 0; i < lastExportIdx; i++) {
          const info = nonExportedTypeDecl(body[i])
          if (info !== null) {
            context.report({ node: body[i], messageId: "typeBeforeExport", data: info })
          }
        }
      }
    }
  }
}

function isExport(stmt) {
  if (stmt.type === "ExportDefaultDeclaration" || stmt.type === "ExportAllDeclaration") return true
  if (stmt.type !== "ExportNamedDeclaration") return false
  // Ignore the bare `export {}` module marker — it exports nothing, it only
  // forces the file to be treated as a module. It is not a real export, so
  // type plumbing is not required to sit below it.
  const isEmptyMarker =
    stmt.declaration === null && stmt.specifiers.length === 0 && stmt.source === null
  return !isEmptyMarker
}

function nonExportedTypeDecl(stmt) {
  if (stmt.type === "TSTypeAliasDeclaration") return { kind: "type alias", name: stmt.id.name }
  if (stmt.type === "TSInterfaceDeclaration") return { kind: "interface", name: stmt.id.name }
  return null
}
