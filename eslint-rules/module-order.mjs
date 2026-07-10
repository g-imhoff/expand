const GROUP = Object.freeze({
  import: 0,
  exportedClassOrInterface: 1,
  otherExport: 2,
  private: 3
})

const LABEL = Object.freeze({
  [GROUP.import]: "an import",
  [GROUP.exportedClassOrInterface]: "an exported class or interface",
  [GROUP.otherExport]: "another export",
  [GROUP.private]: "a non-exported statement"
})

const isDirective = (statement) =>
  statement.type === "ExpressionStatement" && typeof statement.directive === "string"

const sortableBody = (program) => {
  let first = 0
  while (first < program.body.length && isDirective(program.body[first])) first++
  return program.body.slice(first)
}

const groupOf = (statement) => {
  if (statement.type === "ImportDeclaration" || statement.type === "TSImportEqualsDeclaration") {
    return GROUP.import
  }
  if (statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration") {
    const declaration = statement.declaration
    if (declaration?.type === "ClassDeclaration" || declaration?.type === "TSInterfaceDeclaration") {
      return GROUP.exportedClassOrInterface
    }
    if (
      statement.type === "ExportNamedDeclaration" &&
      statement.declaration === null &&
      statement.specifiers.length === 0 &&
      statement.source === null
    ) {
      return GROUP.private
    }
    return GROUP.otherExport
  }
  if (statement.type === "ExportAllDeclaration") return GROUP.otherExport
  return GROUP.private
}

const firstViolation = (statements) => {
  let highest = -1
  for (const statement of statements) {
    const group = groupOf(statement)
    if (group < highest) return { statement, group, previousGroup: highest }
    highest = Math.max(highest, group)
  }
  return null
}

export const moduleOrder = {
  meta: {
    type: "layout",
    docs: { description: "Enforce Expand's top-level module declaration order" },
    schema: [],
    messages: {
      outOfOrder: "Expected {{actual}} before {{previous}}."
    }
  },
  create(context) {
    return {
      Program(program) {
        const violation = firstViolation(sortableBody(program))
        if (violation === null) return
        context.report({
          node: violation.statement,
          messageId: "outOfOrder",
          data: {
            actual: LABEL[violation.group],
            previous: LABEL[violation.previousGroup]
          }
        })
      }
    }
  }
}
