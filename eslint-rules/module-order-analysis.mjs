export const GROUP = Object.freeze({
  import: 0,
  exportedClassOrInterface: 1,
  otherExport: 2,
  private: 3
})

export const LABEL = Object.freeze({
  [GROUP.import]: "an import",
  [GROUP.exportedClassOrInterface]: "an exported class or interface",
  [GROUP.otherExport]: "another export",
  [GROUP.private]: "a non-exported statement"
})

const isDirective = (statement) =>
  statement.type === "ExpressionStatement" && typeof statement.directive === "string"

export const sortableBody = (program) => {
  let first = 0
  while (first < program.body.length && isDirective(program.body[first])) first++
  return program.body.slice(first)
}

export const groupOf = (statement) => {
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
      declaration === null &&
      statement.specifiers.length === 0 &&
      statement.source === null
    ) {
      return GROUP.private
    }
    return GROUP.otherExport
  }
  if (
    statement.type === "ExportAllDeclaration" ||
    statement.type === "TSExportAssignment" ||
    statement.type === "TSNamespaceExportDeclaration"
  ) {
    return GROUP.otherExport
  }
  return GROUP.private
}

export const firstViolation = (statements) => {
  let highest = -1
  for (const statement of statements) {
    const group = groupOf(statement)
    if (group < highest) return { statement, group, previousGroup: highest }
    highest = Math.max(highest, group)
  }
  return null
}

const declarationOf = (statement) =>
  statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration"
    ? statement.declaration
    : statement

const isErased = (statement) => {
  const declaration = declarationOf(statement)
  return (
    declaration?.type === "TSInterfaceDeclaration" ||
    declaration?.type === "TSTypeAliasDeclaration" ||
    declaration?.declare === true
  )
}

const isRuntimeBearing = (statement) => {
  if (statement.type === "ImportDeclaration") return false
  if (isErased(statement)) return false
  if (
    statement.type === "ExportNamedDeclaration" &&
    statement.declaration === null &&
    statement.source === null
  ) {
    return false
  }
  return true
}

const isModuleRequest = (statement) =>
  statement.type === "ImportDeclaration" ||
  (statement.type === "TSImportEqualsDeclaration" &&
    statement.moduleReference.type === "TSExternalModuleReference") ||
  ((statement.type === "ExportNamedDeclaration" || statement.type === "ExportAllDeclaration") &&
    statement.source !== null)

const ownerIndex = (units, identifier) =>
  units.findIndex(({ node }) =>
    node.range[0] <= identifier.range[0] && identifier.range[1] <= node.range[1]
  )

const addEdge = (edges, from, to) => {
  if (from !== to) edges[from].add(to)
}

const buildEdges = (units, sourceCode) => {
  const edges = units.map(() => new Set())
  const runtime = units.filter(({ node }) => isRuntimeBearing(node))
  const requests = units.filter(({ node }) => isModuleRequest(node))
  const previousByGroup = new Map()

  for (const unit of units) {
    const previous = previousByGroup.get(unit.group)
    if (previous !== undefined) addEdge(edges, previous, unit.index)
    previousByGroup.set(unit.group, unit.index)
  }
  for (let i = 1; i < runtime.length; i++) addEdge(edges, runtime[i - 1].index, runtime[i].index)
  for (let i = 1; i < requests.length; i++) addEdge(edges, requests[i - 1].index, requests[i].index)

  for (const provider of units) {
    const declaration = declarationOf(provider.node)
    if (declaration === null) continue
    for (const variable of sourceCode.getDeclaredVariables(declaration)) {
      for (const reference of variable.references) {
        if ("isValueReference" in reference && reference.isValueReference === false) continue
        const consumer = ownerIndex(units, reference.identifier)
        if (consumer !== -1) addEdge(edges, provider.index, consumer)
      }
    }
  }
  return edges
}

const stableTopologicalSort = (units, edges) => {
  const incoming = units.map(() => 0)
  for (const outgoing of edges) {
    for (const target of outgoing) incoming[target]++
  }
  const result = []
  const emitted = new Set()
  while (result.length < units.length) {
    const ready = units
      .filter(({ index }) => !emitted.has(index) && incoming[index] === 0)
      .sort((a, b) => a.group - b.group || a.index - b.index)
    if (ready.length === 0) return null
    const next = ready[0]
    emitted.add(next.index)
    result.push(next)
    for (const target of edges[next.index]) incoming[target]--
  }
  return result
}

const fullyGrouped = (units) => {
  let highest = -1
  for (const unit of units) {
    if (unit.group < highest) return false
    highest = Math.max(highest, unit.group)
  }
  return true
}

const ASI_CONTINUATION_START = new Set(["[", "(", "`", "/", "+", "-", "<"])

const hasUnsafeAsiBoundary = (units, sourceCode) =>
  units.some((right, index) => {
    if (index === 0) return false
    const left = units[index - 1]
    if (left.index + 1 === right.index) return false
    if (right.node.type !== "ExpressionStatement") return false
    const first = sourceCode.getText(right.node).trimStart()[0]
    if (!ASI_CONTINUATION_START.has(first)) return false
    return !sourceCode.getText(left.node).trimEnd().endsWith(";")
  })

const isToolDirective = (comment) =>
  /(?:eslint-(?:disable|enable)|@ts-|@jsx[\w-]*)/iu.test(comment.value) ||
  /^\s*(?:eslint(?:-env)?|globals?|exported)\b/iu.test(comment.value) ||
  /^\s*\/\s*<(?:reference|amd-(?:dependency|module))\b/iu.test(comment.value)

const isJSDoc = (comment) => comment.type === "Block" && comment.value.startsWith("*")

const isFileBanner = (comment, statement) => {
  if (comment.type === "Shebang") return true
  if (isJSDoc(comment)) return false
  return (
    (comment.type === "Block" && comment.loc.end.line + 1 < statement.loc.start.line) ||
    /(?:SPDX-License-Identifier:|@(?:file|fileoverview|license|preserve)\b)/iu.test(comment.value)
  )
}

const indentationStart = (text, index) => {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1
  return /^[\t ]*$/u.test(text.slice(lineStart, index)) ? lineStart : index
}

const hasSafeLeadingGeometry = (sourceCode, previous, node, leading) => {
  if (leading.length === 0) return false
  const contiguous = leading.every(
    (comment, index) => index === 0 || comment.loc.start.line <= leading[index - 1].loc.end.line + 1
  )
  if (!contiguous) return false
  const first = leading[0]
  const final = leading[leading.length - 1]
  if (!/^[\t \r\n]*$/u.test(sourceCode.text.slice(final.range[1], node.range[0]))) return false
  const separatedFromPrevious = first.loc.start.line > previous.loc.end.line + 1
  if (final.loc.end.line === node.loc.start.line) {
    return leading.length === 1 || separatedFromPrevious
  }
  return separatedFromPrevious && final.loc.end.line + 1 === node.loc.start.line
}

const blockBounds = (sourceCode, statements, comments) => {
  const owned = new Set()
  const anchored = new Set(
    sourceCode
      .getCommentsBefore(statements[0])
      .filter((comment) => isFileBanner(comment, statements[0]))
  )
  const blocks = statements.map((node, index) => {
    let start = indentationStart(sourceCode.text, node.range[0])
    let end = node.range[1]
    for (const comment of comments) {
      if (node.range[0] <= comment.range[0] && comment.range[1] <= node.range[1]) {
        owned.add(comment)
      }
    }
    if (index > 0) {
      const previous = statements[index - 1]
      const leading = sourceCode.getCommentsBefore(node).filter(
        (comment) =>
          previous.range[1] <= comment.range[0] &&
          comment.loc.start.line !== previous.loc.end.line
      )
      if (hasSafeLeadingGeometry(sourceCode, previous, node, leading)) {
        start = indentationStart(sourceCode.text, leading[0].range[0])
        for (const comment of leading) owned.add(comment)
      }
    }
    const trailing = sourceCode
      .getCommentsAfter(node)
      .filter(
        (comment) => comment.loc.start.line === node.loc.end.line && comment.type === "Line"
      )
    if (trailing.length > 0) end = trailing[trailing.length - 1].range[1]
    for (const comment of trailing) owned.add(comment)
    return { start, end, text: sourceCode.text.slice(start, end) }
  })
  return { comments, owned, anchored, blocks }
}

const hasSharedLineBoundary = (text, range) => {
  const lineStart = text.lastIndexOf("\n", range[0] - 1) + 1
  const nextLine = text.indexOf("\n", range[1])
  const lineEnd = nextLine === -1 ? text.length : nextLine
  return /\S/u.test(text.slice(lineStart, range[0])) || /\S/u.test(text.slice(range[1], lineEnd))
}

const buildReplacement = (sourceCode, original, sorted) => {
  let first = 0
  while (first < original.length && original[first].index === sorted[first].index) first++
  if (first === original.length) return null
  let last = original.length - 1
  while (last > first && original[last].index === sorted[last].index) last--

  const statements = original.map(({ node }) => node)
  const comments = sourceCode.getAllComments()
  if (comments.some(isToolDirective)) return null
  const { owned, anchored, blocks } = blockBounds(sourceCode, statements, comments)
  if (comments.some((comment) => !owned.has(comment) && !anchored.has(comment))) return null

  const range = [blocks[first].start, blocks[last].end]
  if (hasSharedLineBoundary(sourceCode.text, range)) return null
  const relevantComments = comments.filter(
    (comment) => range[0] <= comment.range[0] && comment.range[1] <= range[1]
  )
  if (relevantComments.some((comment) => !owned.has(comment))) return null

  const newline = sourceCode.text.includes("\r\n") ? "\r\n\r\n" : "\n\n"
  return {
    range,
    text: sorted
      .slice(first, last + 1)
      .map(({ index }) => blocks[index].text)
      .join(newline)
  }
}

export const analyzeModule = (sourceCode, program) => {
  const statements = sortableBody(program)
  const violation = firstViolation(statements)
  if (violation === null) return null

  const units = statements.map((node, index) => ({ node, index, group: groupOf(node) }))
  const sorted = stableTopologicalSort(units, buildEdges(units, sourceCode))
  if (sorted === null || !fullyGrouped(sorted)) return { violation, fix: null }

  const changed = sorted.some((unit, index) => unit.index !== index)
  if (!changed) return { violation, fix: null }

  if (hasUnsafeAsiBoundary(sorted, sourceCode)) return { violation, fix: null }
  const replacement = buildReplacement(sourceCode, units, sorted)
  return { violation, fix: replacement }
}
