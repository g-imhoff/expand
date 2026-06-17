/**
 * Bans `export * from "..."` (and `export * as ns from "..."`).
 *
 * Wildcard re-exports make a module's public surface IMPLICIT — you cannot see
 * what it exports without opening every re-exported source — and they hide
 * unused exports from dead-code analysis: Knip resolves *through* `export *`, so
 * a dead re-exported binding can never be flagged. Re-export the bindings by name
 * instead, e.g. `export { Foo, Bar } from "./module"`.
 *
 * @type {import('eslint').Rule.RuleModule}
 */
export const noExportStar = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow `export *` wildcard re-exports; list the re-exported bindings explicitly"
    },
    schema: [],
    messages: {
      noStar:
        "Avoid `export *` — it makes the module's exports implicit and hides unused exports from dead-code analysis. Re-export the bindings by name instead, e.g. export { Foo, Bar } from \"./module\"."
    }
  },
  create(context) {
    return {
      ExportAllDeclaration(node) {
        context.report({ node, messageId: "noStar" })
      }
    }
  }
}
