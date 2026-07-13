import {
  ambientPlatformConstructors,
  ambientPlatformFunctions,
  ambientPlatformMembers,
  ambientPlatformObjects,
  deterministicNodeUrlExports,
  effectCallbackMethods,
  effectFunctionMethods,
  effectRunnerMethods,
  hostUrlMethods,
  isNodeBuiltin,
  isPlatformPackage,
  listenerMethods,
  managedRuntimeRunnerMethods,
  nativePromiseStatics,
  nodeRuntimeRunnerMethods,
  promiseChainMethods,
  resourceMethods,
  runtimeRunnerMethods,
  schemaSyncMethods
} from "./effect-boundary-policy.mjs"

const repositoryRoot = new URL("../", import.meta.url).pathname
const functionTypes = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression"
])
const checkerSignatureTypes = new Set([
  "TSCallSignatureDeclaration",
  "TSConstructSignatureDeclaration",
  "TSConstructorType",
  "TSDeclareFunction",
  "TSFunctionType",
  "TSMethodSignature",
  "TSEmptyBodyFunctionExpression"
])
const checkerValueTypes = new Set([
  "AccessorProperty",
  "PropertyDefinition",
  "TSAbstractPropertyDefinition",
  "TSIndexSignature",
  "TSMappedType",
  "TSPropertySignature",
  "TSTypeAliasDeclaration"
])
const transparentExpressionTypes = new Set([
  "ChainExpression",
  "TSAsExpression",
  "TSInstantiationExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion"
])
const runnerInvocationMethods = new Set(["apply", "bind", "call"])
const realGlobalObjectNames = new Set(["global", "globalThis", "self", "window"])
const declarationTypes = new Set([
  "ClassDeclaration",
  "FunctionDeclaration",
  "TSDeclareFunction",
  "TSEnumDeclaration",
  "TSInterfaceDeclaration",
  "TSModuleDeclaration",
  "TSTypeAliasDeclaration",
  "VariableDeclarator"
])

const normalizedFilename = (filename) => {
  const normalized = filename.replaceAll("\\", "/")
  const root = repositoryRoot.replaceAll("\\", "/")
  return normalized.startsWith(root) ? normalized.slice(root.length) : normalized
}

const propertyName = (node) => {
  if (node === null || node === undefined) return undefined
  if (node.type === "Identifier" || node.type === "PrivateIdentifier") return node.name
  if (node.type === "Literal") return typeof node.value === "string" || typeof node.value === "number"
    ? String(node.value)
    : undefined
  return undefined
}

const patternName = (node) => {
  if (node === null || node === undefined) return "<anonymous>"
  if (node.type === "Identifier") return node.name
  if (node.type === "AssignmentPattern") return patternName(node.left)
  if (node.type === "RestElement") return patternName(node.argument)
  if (node.type === "ArrayPattern") return "[destructured]"
  if (node.type === "ObjectPattern") return "{destructured}"
  return "<anonymous>"
}

const importName = (node) => {
  if (node.type === "Identifier") return node.name
  if (node.type === "Literal" && typeof node.value === "string") return node.value
  return "default"
}

const staticStringValue = (node) => {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0 && node.quasis.length === 1) {
    return node.quasis[0].value.cooked ?? node.quasis[0].value.raw
  }
  return undefined
}

const memberName = (node) => {
  if (node.computed) return staticStringValue(node.property)
  return propertyName(node.property)
}

const objectPropertyName = (node) => node.computed ? staticStringValue(node.key) : propertyName(node.key)

const requiredModuleProvenance = (source) => {
  if (source === "effect") return "module:effect"
  const effectModule = source.match(/^effect\/(Effect|ManagedRuntime|Runtime|Schema)$/u)
  if (effectModule !== null) return `namespace:${effectModule[1]}`
  if (source === "@effect/platform-node/NodeRuntime"
    || source === "@effect/platform-node-shared/NodeRuntime") return "namespace:NodeRuntime"
  if (source === "@effect/platform-node" || source === "@effect/platform-node-shared") {
    return "module:@effect/platform-node"
  }
  if (isNodeBuiltin(source) || isPlatformPackage(source)) return `platform-import:${source}:*`
  return null
}

const importProvenance = (specifier, source) => {
  const imported = specifier.type === "ImportSpecifier" ? importName(specifier.imported) : "default"
  const namespace = specifier.type === "ImportNamespaceSpecifier"
  if (source === "effect") {
    if (namespace) return "module:effect"
    if (["Effect", "ManagedRuntime", "Runtime", "Schema"].includes(imported)) {
      return `namespace:${imported}`
    }
    return null
  }
  const effectModule = source.match(/^effect\/(Effect|ManagedRuntime|Runtime|Schema)$/u)
  if (effectModule !== null) {
    const root = effectModule[1]
    if (namespace || specifier.type === "ImportDefaultSpecifier") return `namespace:${root}`
    return `method:${root}:${imported}`
  }
  const nodeRuntimeModule = source === "@effect/platform-node/NodeRuntime"
    || source === "@effect/platform-node-shared/NodeRuntime"
  if (nodeRuntimeModule) {
    if (namespace || specifier.type === "ImportDefaultSpecifier") return "namespace:NodeRuntime"
    return `method:NodeRuntime:${imported}`
  }
  if (source === "@effect/platform-node" || source === "@effect/platform-node-shared") {
    if (namespace) return "module:@effect/platform-node"
    if (imported === "NodeRuntime") return "namespace:NodeRuntime"
    return null
  }
  if (isNodeBuiltin(source) || isPlatformPackage(source)) {
    return `platform-import:${source}:${namespace ? "*" : imported}`
  }
  return null
}

const isDeterministicNodeUrlImport = (node) => {
  if (!["node:url", "url"].includes(node.source.value)) return false
  const runtimeSpecifiers = node.specifiers.filter((specifier) => specifier.importKind !== "type")
  return runtimeSpecifiers.length > 0
    && runtimeSpecifiers.every((specifier) => specifier.type === "ImportSpecifier"
      && deterministicNodeUrlExports.includes(importName(specifier.imported)))
}

const isTypeOnlyImport = (node) => node.importKind === "type"
  || (node.specifiers.length > 0 && node.specifiers.every((specifier) => specifier.importKind === "type"))

const isTypeOnlyExport = (node) => node.exportKind === "type"
  || (node.type === "ExportNamedDeclaration"
    && node.specifiers.length > 0
    && node.specifiers.every((specifier) => specifier.exportKind === "type"))

const isAmbientPlatformMember = (path) =>
  ambientPlatformMembers.some((member) => path === member || path.startsWith(`${member}.`))

const isNode = (value) =>
  value !== null && typeof value === "object" && typeof value.type === "string"

const collectTree = (root) => {
  const nodes = []
  const parents = new WeakMap()
  const visited = new WeakSet()
  const visit = (node, parent) => {
    if (!isNode(node) || visited.has(node)) return
    visited.add(node)
    nodes.push(node)
    if (parent !== null) parents.set(node, parent)
    for (const [key, value] of Object.entries(node)) {
      if (["comments", "loc", "parent", "range", "tokens"].includes(key)) continue
      if (Array.isArray(value)) {
        for (const child of value) visit(child, node)
      } else {
        visit(value, node)
      }
    }
  }
  visit(root, null)
  const structuralNodes = [...nodes]
  nodes.sort((left, right) => {
    const leftRange = left.range ?? [0, 0]
    const rightRange = right.range ?? [0, 0]
    return leftRange[0] - rightRange[0] || leftRange[1] - rightRange[1]
  })
  return { nodes, structuralNodes, parents }
}

const classFor = (node, parents) => {
  let current = node
  while (current !== undefined) {
    if (current.type === "ClassDeclaration" || current.type === "ClassExpression") {
      return current
    }
    current = parents.get(current)
  }
  return undefined
}

const typeOwnerFor = (node, parents) => {
  let current = parents.get(node)
  while (current !== undefined) {
    if (current.type === "TSInterfaceDeclaration") {
      return { anchor: current, declaration: `interface:${current.id.name}` }
    }
    if (current.type === "TSTypeAliasDeclaration") {
      return { anchor: current, declaration: `type:${current.id.name}` }
    }
    if (current.type === "ClassDeclaration" || current.type === "ClassExpression") {
      return { anchor: current, declaration: `class:${current.id?.name ?? "<anonymous>"}` }
    }
    current = parents.get(current)
  }
  return { anchor: undefined, declaration: "module:<module>" }
}

const variableOwnerForProperty = (node, parents) => {
  let current = parents.get(node)
  while (current !== undefined) {
    if (current.type === "VariableDeclarator") return patternName(current.id)
    if (current.type === "Property" && current !== node) {
      const parentName = propertyName(current.key) ?? "<computed>"
      return `${variableOwnerForProperty(current, parents)}.${parentName}`
    }
    if (functionTypes.has(current.type) || declarationTypes.has(current.type)) break
    current = parents.get(current)
  }
  return "<object>"
}

const variableAnchorForProperty = (node, parents) => {
  let current = parents.get(node)
  while (current !== undefined) {
    if (current.type === "VariableDeclarator") return current
    if (functionTypes.has(current.type) || declarationTypes.has(current.type)) break
    current = parents.get(current)
  }
  return node
}

const declarationDetailsFor = (node, parents) => {
  let current = node
  while (current !== undefined) {
    const parent = parents.get(current)
    if ([
      "MethodDefinition",
      "PropertyDefinition",
      "TSAbstractMethodDefinition",
      "TSAbstractPropertyDefinition"
    ].includes(current.type)) {
      const owner = classFor(current, parents)
      return {
        anchor: owner ?? current,
        declaration: `member:${owner?.id?.name ?? "<anonymous>"}.${propertyName(current.key) ?? "<computed>"}`
      }
    }
    if (["TSCallSignatureDeclaration", "TSConstructSignatureDeclaration", "TSIndexSignature"].includes(current.type)) {
      const owner = typeOwnerFor(current, parents)
      return { anchor: owner.anchor ?? current, declaration: `${owner.declaration}.<signature>` }
    }
    if (["TSMethodSignature", "TSPropertySignature"].includes(current.type)) {
      const owner = typeOwnerFor(current, parents)
      return {
        anchor: owner.anchor ?? current,
        declaration: `${owner.declaration}.${propertyName(current.key) ?? "<computed>"}`
      }
    }
    if (current.type === "Property" && parent?.type === "ObjectExpression") {
      return {
        anchor: variableAnchorForProperty(current, parents),
        declaration: `property:${variableOwnerForProperty(current, parents)}.${propertyName(current.key) ?? "<computed>"}`
      }
    }
    if (current.type === "FunctionDeclaration" || current.type === "TSDeclareFunction") {
      return { anchor: current, declaration: `function:${current.id?.name ?? "<anonymous>"}` }
    }
    if (current.type === "FunctionExpression" && parent?.type !== "MethodDefinition") {
      if (current.id !== null && current.id !== undefined) {
        return { anchor: current, declaration: `function:${current.id.name}` }
      }
    }
    if (current.type === "VariableDeclarator") {
      return { anchor: current, declaration: `variable:${patternName(current.id)}` }
    }
    if (current.type === "ClassDeclaration") {
      return { anchor: current, declaration: `class:${current.id?.name ?? "<anonymous>"}` }
    }
    if (current.type === "TSInterfaceDeclaration") {
      return { anchor: current, declaration: `interface:${current.id.name}` }
    }
    if (current.type === "TSTypeAliasDeclaration") {
      return { anchor: current, declaration: `type:${current.id.name}` }
    }
    if (current.type === "TSEnumDeclaration") {
      return { anchor: current, declaration: `enum:${current.id.name}` }
    }
    if (current.type === "TSModuleDeclaration") {
      return { anchor: current, declaration: `namespace:${propertyName(current.id) ?? "<anonymous>"}` }
    }
    current = parent
  }
  return { anchor: undefined, declaration: "module:<module>" }
}

const isAnonymousFunctionScope = (node) => functionTypes.has(node.type)
  && (node.type === "ArrowFunctionExpression" || node.id === null || node.id === undefined)

const isLexicalBlockScope = (node, parents) => {
  if (node.type !== "BlockStatement") return false
  const parent = parents.get(node)
  return !functionTypes.has(parent?.type) || parent.body !== node
}

const lexicalContainerFor = (node, parents) => {
  let current = parents.get(node)
  while (current !== undefined) {
    if (current.type === "Program" || functionTypes.has(current.type)) return current
    if (isLexicalBlockScope(current, parents)) return current
    current = parents.get(current)
  }
  return undefined
}

const calleeRoleFor = (node) => {
  if (node?.type === "Identifier") return `identifier:${node.name}`
  if (node?.type === "MemberExpression") {
    return `member:${calleeRoleFor(node.object)}:${memberName(node) ?? "<dynamic>"}`
  }
  if (node?.type === "CallExpression") return `call:${calleeRoleFor(node.callee)}`
  return node?.type ?? "<unknown>"
}

const parentFieldFor = (node, parent) => {
  if (parent === undefined) return "<root>"
  for (const [key, value] of Object.entries(parent)) {
    if (["comments", "loc", "parent", "range", "tokens"].includes(key)) continue
    if (value === node) return key
    if (Array.isArray(value) && value.includes(node)) return key
  }
  return "<unknown>"
}

const scopeRoleFor = (node, parents) => {
  let value = node
  let parent = parents.get(value)
  while (parent !== undefined && transparentExpressionTypes.has(parent.type) && parent.expression === value) {
    value = parent
    parent = parents.get(value)
  }
  if (isAnonymousFunctionScope(node)) {
    if (parent?.type === "CallExpression") {
      return `call:${calleeRoleFor(parent.callee)}:argument:${parent.arguments.indexOf(value)}`
    }
    if (parent?.type === "Property" && parent.value === value) {
      const object = parents.get(parent)
      const call = parents.get(object)
      if (object?.type === "ObjectExpression" && call?.type === "CallExpression") {
        return `call:${calleeRoleFor(call.callee)}:property:${objectPropertyName(parent) ?? "<computed>"}`
      }
    }
  }
  return `${parent?.type ?? "<root>"}:${parentFieldFor(value, parent)}`
}

const scopeIndexFor = (node, nodes, parents, predicate, role) => {
  const container = lexicalContainerFor(node, parents)
  return nodes.filter((candidate) => predicate(candidate, parents)
    && lexicalContainerFor(candidate, parents) === container
    && scopeRoleFor(candidate, parents) === role).indexOf(node)
}

const scopeDetailsFor = (node, nodes, parents) => {
  const role = scopeRoleFor(node, parents)
  if (isAnonymousFunctionScope(node)) {
    return `scope:anonymous:${role}:${scopeIndexFor(node, nodes, parents, isAnonymousFunctionScope, role)}`
  }
  if (isLexicalBlockScope(node, parents)) {
    return `scope:block:${role}:${scopeIndexFor(node, nodes, parents, isLexicalBlockScope, role)}`
  }
  return undefined
}

const nodeDepth = (node, parents) => {
  let depth = 0
  let current = node
  while (current !== undefined) {
    depth += 1
    current = parents.get(current)
  }
  return depth
}

const declarationFor = (node, parents, nodes) => {
  const declaration = declarationDetailsFor(node, parents)
  if (declaration.anchor === undefined) return declaration.declaration
  const ancestors = []
  let current = parents.get(declaration.anchor)
  while (current !== undefined) {
    const ancestor = declarationDetailsFor(current, parents)
    if (ancestor.anchor === undefined) break
    ancestors.push({ anchor: ancestor.anchor, declaration: ancestor.declaration })
    current = parents.get(ancestor.anchor)
  }
  current = parents.get(declaration.anchor)
  while (current !== undefined) {
    const scope = scopeDetailsFor(current, nodes, parents)
    if (scope !== undefined) ancestors.push({ anchor: current, declaration: scope })
    current = parents.get(current)
  }
  ancestors.sort((left, right) => nodeDepth(left.anchor, parents) - nodeDepth(right.anchor, parents))
  return [...ancestors.map((ancestor) => ancestor.declaration), declaration.declaration].join("/")
}

const unwrapExpression = (node) => {
  let current = node
  while (current !== null && current !== undefined && transparentExpressionTypes.has(current.type)) {
    current = current.expression
  }
  return current
}

export const analyzeEffectBoundaryProgram = ({ filename, sourceCode, parserServices }) => {
  const file = normalizedFilename(filename)
  const { nodes, structuralNodes, parents } = collectTree(sourceCode.ast)
  const candidates = []
  const declarations = new Set(["module:<module>"])
  const variableCache = new WeakMap()
  const variableResolving = new WeakSet()
  const referenceVariables = new WeakMap()
  const occurrenceIdentities = new WeakMap()
  const reported = new Set()

  const isCapabilityProvenance = (provenance) => {
    if (provenance === null) return false
    if (provenance === "import-meta" || provenance.startsWith("import-meta:")) return true
    if (provenance.startsWith("method:")
      || provenance.startsWith("namespace:")
      || provenance.startsWith("module:effect")
      || provenance.startsWith("module:@effect/platform-node")
      || provenance.startsWith("instance:ManagedRuntime")
      || provenance.startsWith("platform-import:")
      || provenance.startsWith("schema-factory:")) return true
    if (!provenance.startsWith("global:")) return false
    const path = provenance.slice("global:".length)
    const root = path.split(".")[0]
    return realGlobalObjectNames.has(root)
      || ["Date", "Math", "Promise", "URL", "crypto", "performance"].includes(root)
      || ambientPlatformObjects.includes(root)
      || ambientPlatformFunctions.includes(root)
      || ambientPlatformConstructors.includes(root)
  }

  const provenanceAtMember = (base, member) => {
    if (base === null) return null
    if (member === undefined) return isCapabilityProvenance(base) ? `dynamic:${base}` : null
    if (runnerInvocationMethods.has(member) && isCapabilityProvenance(base)) return base
    if (base === "module:effect" && ["Effect", "ManagedRuntime", "Runtime", "Schema"].includes(member)) {
      return `namespace:${member}`
    }
    if (base === "module:@effect/platform-node" && member === "NodeRuntime") return "namespace:NodeRuntime"
    if (base.startsWith("namespace:")) return `method:${base.slice("namespace:".length)}:${member}`
    if (base === "instance:ManagedRuntime") return `method:ManagedRuntimeInstance:${member}`
    if (base.startsWith("global:") && realGlobalObjectNames.has(base.slice("global:".length))) {
      return `global:${member}`
    }
    if (base.startsWith("global:")) return `${base}.${member}`
    if (base === "import-meta") return `import-meta:${member}`
    if (base.startsWith("import-meta:")) return `${base}.${member}`
    const nodeUrl = base.match(/^platform-import:(node:url|url):\*$/u)
    if (nodeUrl !== null && deterministicNodeUrlExports.includes(member)) {
      return `platform-import:${nodeUrl[1]}:${member}`
    }
    if (base.startsWith("platform-import:")) return `${base}.${member}`
    return null
  }

  for (const scope of sourceCode.scopeManager?.scopes ?? []) {
    for (const reference of scope.references ?? []) {
      referenceVariables.set(reference.identifier, reference.resolved ?? null)
    }
  }

  const variableForIdentifier = (identifier) => {
    const direct = referenceVariables.get(identifier)
    if (direct !== undefined && direct !== null) return direct
    let scope
    try {
      scope = sourceCode.getScope(identifier)
    } catch {
      scope = undefined
    }
    while (scope !== null && scope !== undefined) {
      const variable = scope.variables?.find((candidate) => candidate.name === identifier.name)
      if (variable !== undefined) return variable
      scope = scope.upper
    }
    return direct ?? null
  }

  const provenanceOfExpression = (input) => {
    const node = unwrapExpression(input)
    if (node === null || node === undefined) return null
    if (node.type === "MetaProperty" && node.meta.name === "import" && node.property.name === "meta") {
      return "import-meta"
    }
    if (node.type === "Identifier") return provenanceOfIdentifier(node)
    if (node.type === "MemberExpression") {
      const base = provenanceOfExpression(node.object)
      const member = memberName(node)
      const direct = provenanceAtMember(base, member)
      if (direct !== null) return direct
      const source = member === undefined ? undefined : sourceValueAtPath(node.object, [member])
      return source === undefined ? null : provenanceOfExpression(source)
    }
    if (node.type === "CallExpression") {
      const callee = provenanceOfExpression(node.callee)
      const source = staticStringValue(node.arguments[0])
      if (source !== undefined && (callee === "global:require" || callee === "global:module.require")) {
        return requiredModuleProvenance(source)
      }
      if (callee === "method:ManagedRuntime:make") return "instance:ManagedRuntime"
      if (callee?.startsWith("method:Schema:")) {
        const method = callee.slice("method:Schema:".length)
        if (schemaSyncMethods.includes(method)) return `schema-factory:${method}`
      }
      if (callee === "method:Effect:fn" || callee === "method:Effect:fnUntraced") {
        return `builder:${callee.slice("method:".length)}`
      }
      if (callee?.startsWith("builder:Effect:")) {
        return `wrapped:${callee.slice("builder:".length)}`
      }
      return null
    }
    return null
  }

  const destructuredPathFor = (pattern, name, prefix = []) => {
    if (pattern.type !== "ObjectPattern") return undefined
    for (const property of pattern.properties) {
      if (property.type === "RestElement") {
        if (patternName(property.argument) === name) return prefix
        continue
      }
      const local = property.value.type === "AssignmentPattern" ? property.value.left : property.value
      const member = objectPropertyName(property)
      if (patternName(local) === name) return [...prefix, member]
      if (member === undefined) continue
      if (local.type === "ObjectPattern") {
        const nested = destructuredPathFor(local, name, [...prefix, member])
        if (nested !== undefined) return nested
      }
    }
    return undefined
  }

  const provenanceOfVariable = (variable) => {
    if (variableCache.has(variable)) return variableCache.get(variable)
    if (variableResolving.has(variable)) return null
    variableResolving.add(variable)
    let provenance = null
    for (const definition of variable.defs ?? []) {
      if (definition.type === "ImportBinding") {
        const specifier = definition.node
        if (specifier.type === "TSImportEqualsDeclaration") {
          const source = specifier.moduleReference?.expression?.value
          if (specifier.importKind !== "type" && typeof source === "string") {
            provenance = requiredModuleProvenance(source)
          }
        } else {
          const declaration = parents.get(specifier)
          const source = declaration?.source?.value
          if (!isTypeOnlyImport(declaration) && typeof source === "string") {
            provenance = importProvenance(specifier, source)
          }
        }
      }
      if (definition.type === "Variable") {
        const declarator = definition.node
        if (declarator.id.type === "Identifier") {
          provenance = provenanceOfExpression(declarator.init)
        } else {
          const path = destructuredPathFor(declarator.id, variable.name)
          if (path !== undefined) {
            provenance = provenanceOfExpression(declarator.init)
            for (const member of path) provenance = provenanceAtMember(provenance, member)
          }
        }
      }
      if (provenance !== null) break
    }
    variableResolving.delete(variable)
    variableCache.set(variable, provenance)
    return provenance
  }

  function provenanceOfIdentifier(identifier) {
    const variable = variableForIdentifier(identifier)
    if (variable !== null && (variable.defs?.length ?? 0) > 0) return provenanceOfVariable(variable)
    return `global:${identifier.name}`
  }

  const add = (messageId, node, construct) => {
    const range = node.range ?? [0, 0]
    const key = `${messageId}\u0000${construct}\u0000${range[0]}\u0000${range[1]}`
    if (reported.has(key)) return
    reported.add(key)
    candidates.push({ messageId, node, construct })
  }

  const contains = (ancestor, descendant) => {
    const outer = ancestor.range
    const inner = descendant.range
    return outer !== undefined && inner !== undefined && outer[0] <= inner[0] && inner[1] <= outer[1]
  }

  const effectMethodForCall = (call) => {
    const callee = provenanceOfExpression(call.callee)
    if (callee?.startsWith("method:Effect:")) return callee.slice("method:Effect:".length)
    if (callee?.startsWith("builder:Effect:")) return callee.slice("builder:Effect:".length)
    return undefined
  }

  const callbackOwnerCache = new WeakMap()

  const callbackFunctionOf = (input, seen = new WeakSet()) => {
    const node = unwrapExpression(input)
    if (node === null || node === undefined) return undefined
    if (functionTypes.has(node.type)) return node
    if (node.type !== "Identifier") return undefined
    const variable = variableForIdentifier(node)
    if (variable === null || seen.has(variable)) return undefined
    seen.add(variable)
    for (const definition of variable.defs ?? []) {
      if (definition.node?.type === "FunctionDeclaration") return definition.node
      if (definition.type === "Variable" && definition.node.id.type === "Identifier") {
        const resolved = callbackFunctionOf(definition.node.init, seen)
        if (resolved !== undefined) return resolved
      }
    }
    return undefined
  }

  const callbackOwners = (fn) => {
    const cached = callbackOwnerCache.get(fn)
    if (cached !== undefined) return cached
    const owners = []
    for (const node of nodes) {
      if (node.type !== "CallExpression") continue
      for (const argument of node.arguments) {
        if (argument.type === "SpreadElement") continue
        if (callbackFunctionOf(argument) === fn) owners.push({ call: node, property: undefined })
        if (argument.type !== "ObjectExpression") continue
        for (const property of argument.properties) {
          if (property.type === "Property" && callbackFunctionOf(property.value) === fn) {
            owners.push({ call: node, property: objectPropertyName(property) })
          }
        }
      }
    }
    callbackOwnerCache.set(fn, owners)
    return owners
  }

  const isEffectCallback = (fn, requiredMethod) => {
    return callbackOwners(fn).some((owner) => {
      const method = effectMethodForCall(owner.call)
      return method !== undefined && effectCallbackMethods.includes(method)
        && (requiredMethod === undefined || method === requiredMethod)
    })
  }

  const isTryPromiseProducer = (fn) => callbackOwners(fn).some((owner) =>
    effectMethodForCall(owner.call) === "tryPromise"
      && (owner.property === undefined || owner.property === "try"))

  const isWithinEffectCallback = (node) => {
    let current = parents.get(node)
    while (current !== undefined) {
      if (functionTypes.has(current.type) && isEffectCallback(current)) return true
      current = parents.get(current)
    }
    return false
  }

  const isOutputPosition = (node, output) => {
    let current = node
    while (current !== output) {
      const parent = parents.get(current)
      if (parent === undefined) return false
      if (transparentExpressionTypes.has(parent.type) && parent.expression === current) {
        current = parent
        continue
      }
      if (parent.type === "ConditionalExpression"
        && (parent.consequent === current || parent.alternate === current)) {
        current = parent
        continue
      }
      if (parent.type === "SequenceExpression" && parent.expressions.at(-1) === current) {
        current = parent
        continue
      }
      return false
    }
    return true
  }

  const isDirectCallbackOutput = (node, fn) => {
    if (fn.returnType?.typeAnnotation === node) return true
    if (fn.body.type !== "BlockStatement") return isOutputPosition(node, fn.body)
    let current = node
    while (current !== undefined && current !== fn) {
      if (current.type === "ReturnStatement" && current.argument !== null) {
        return isOutputPosition(node, current.argument)
      }
      current = parents.get(current)
    }
    return false
  }

  const isDirectTryPromiseConsumption = (node) => {
    let current = parents.get(node)
    while (current !== undefined) {
      if (functionTypes.has(current.type)) {
        return isTryPromiseProducer(current) && isDirectCallbackOutput(node, current)
      }
      current = parents.get(current)
    }
    return false
  }

  const isDeterministicNodeUrlRequire = (node, source) => {
    if (!["node:url", "url"].includes(source)) return false
    let current = node
    let parent = parents.get(current)
    while (parent !== undefined && transparentExpressionTypes.has(parent.type) && parent.expression === current) {
      current = parent
      parent = parents.get(current)
    }
    if (parent?.type !== "VariableDeclarator" || parent.init !== current || parent.id.type !== "ObjectPattern") {
      return false
    }
    return parent.id.properties.length > 0 && parent.id.properties.every((property) =>
      property.type === "Property" && deterministicNodeUrlExports.includes(objectPropertyName(property)))
  }

  const runnerConstruct = (provenance) => {
    if (provenance?.startsWith("method:Effect:")) {
      const method = provenance.slice("method:Effect:".length)
      if (effectRunnerMethods.includes(method)) return `runner:Effect.${method}`
    }
    if (provenance?.startsWith("method:Runtime:")) {
      const method = provenance.slice("method:Runtime:".length)
      if (runtimeRunnerMethods.includes(method)) return `runner:Runtime.${method}`
    }
    if (provenance?.startsWith("method:ManagedRuntime:")) {
      const method = provenance.slice("method:ManagedRuntime:".length)
      if (managedRuntimeRunnerMethods.includes(method)) return `runner:ManagedRuntime.${method}`
    }
    if (provenance?.startsWith("method:ManagedRuntimeInstance:")) {
      const method = provenance.slice("method:ManagedRuntimeInstance:".length)
      if (managedRuntimeRunnerMethods.includes(method)) return `runner:ManagedRuntime.${method}`
    }
    if (provenance?.startsWith("method:NodeRuntime:")) {
      const method = provenance.slice("method:NodeRuntime:".length)
      if (nodeRuntimeRunnerMethods.includes(method)) return `runner:NodeRuntime.${method}`
    }
    return undefined
  }

  const runnerExportConstruct = (provenance) => {
    const runner = runnerConstruct(provenance)
    if (runner !== undefined) return runner
    if ([
      "module:effect",
      "module:@effect/platform-node",
      "namespace:Effect",
      "namespace:ManagedRuntime",
      "namespace:NodeRuntime",
      "namespace:Runtime"
    ].includes(provenance)) {
      return `runner-re-export:${provenance}`
    }
    return undefined
  }

  const platformExportConstruct = (provenance) => provenance?.startsWith("platform-import:")
    && !isDeterministicNodeUrlProvenance(provenance)
    ? `platform-export:${provenance.slice("platform-import:".length)}`
    : undefined

  const addExportedProvenance = (node, provenance) => {
    const runner = runnerExportConstruct(provenance)
    if (runner !== undefined) add("runnerOutsideBoundary", node, runner)
    const platform = platformExportConstruct(provenance)
    if (platform !== undefined) add("platformEffect", node, platform)
  }

  const addDynamicCapabilityFinding = (node, target) => {
    if ([
      "instance:ManagedRuntime",
      "module:effect",
      "module:@effect/platform-node",
      "namespace:Effect",
      "namespace:ManagedRuntime",
      "namespace:NodeRuntime",
      "namespace:Runtime"
    ].includes(target)) {
      add("runnerOutsideBoundary", node, `runner-dynamic:${target}`)
    } else if (target === "namespace:Schema" && isWithinEffectCallback(node)) {
      add("syncSchemaInEffect", node, "schema:Schema.<dynamic>")
    } else if (target === "global:Promise") {
      add("nativePromise", node, "promise:Promise.<dynamic>")
    } else {
      add("platformEffect", node, `platform-dynamic:${target}`)
    }
  }

  const globalPath = (node) => {
    const provenance = provenanceOfExpression(node)
    return provenance?.startsWith("global:") ? provenance.slice("global:".length) : undefined
  }

  const hostUrlMethodFor = (provenance) => {
    if (provenance?.startsWith("global:URL.")) {
      const method = provenance.slice("global:URL.".length)
      return hostUrlMethods.includes(method) ? method : undefined
    }
    const match = provenance?.match(/^platform-import:(?:node:url|url):URL\.(.+)$/u)
    return match !== undefined && match !== null && hostUrlMethods.includes(match[1]) ? match[1] : undefined
  }

  const isDeterministicNodeUrlProvenance = (provenance) =>
    /^platform-import:(?:node:url|url):(?:URL|URLSearchParams)(?:\.|$)/u.test(provenance ?? "")

  const isOutermostMember = (node) => {
    const parent = parents.get(node)
    return parent?.type !== "MemberExpression" || parent.object !== node
  }

  const invocationHelperTarget = (callee) => callee.type === "MemberExpression"
    && runnerInvocationMethods.has(memberName(callee))
    ? unwrapExpression(callee.object)
    : undefined

  const promiseChainMethodForCall = (call) => {
    if (call.callee.type !== "MemberExpression") return undefined
    const direct = memberName(call.callee)
    if (direct !== undefined && promiseChainMethods.includes(direct)) return direct
    const target = invocationHelperTarget(call.callee)
    if (target?.type !== "MemberExpression") return undefined
    const method = memberName(target)
    return method !== undefined && promiseChainMethods.includes(method) ? method : undefined
  }

  const isDirectCallableMemberReference = (node) => {
    const parent = parents.get(node)
    if (["CallExpression", "NewExpression"].includes(parent?.type) && parent.callee === node) return false
    return parent?.type !== "MemberExpression" || parent.object !== node
      || !runnerInvocationMethods.has(memberName(parent))
  }

  const isRunnerReference = (node) => {
    if (node.type !== "Identifier" && node.type !== "MemberExpression") return false
    const parent = parents.get(node)
    if (parent?.type === "CallExpression" && parent.callee === node) return false
    if (parent?.type === "VariableDeclarator" && (parent.id === node || parent.init === node)) return false
    if (parent?.type === "AssignmentPattern" && parent.left === node) return false
    if (parent?.type === "MemberExpression" && parent.object === node
      && runnerInvocationMethods.has(memberName(parent))) return false
    if (node.type === "MemberExpression") return isOutermostMember(node)
    if (["ImportDefaultSpecifier", "ImportNamespaceSpecifier", "ImportSpecifier"].includes(parent?.type)) return false
    if (parent?.type === "ExportDefaultDeclaration" || parent?.type === "ExportSpecifier") return false
    if (parent?.type === "MemberExpression" && parent.property === node && !parent.computed) return false
    if (parent?.type === "Property" && parents.get(parent)?.type === "ObjectPattern") return false
    if (parent?.type === "Property" && parent.key === node && !parent.computed && parent.value !== node) return false
    return true
  }

  const isPlatformImportReference = (node) => {
    if (node.type !== "Identifier" && node.type !== "MemberExpression") return false
    const provenance = provenanceOfExpression(node)
    if (!provenance?.startsWith("platform-import:") || isDeterministicNodeUrlProvenance(provenance)) return false
    const parent = parents.get(node)
    if (node.type === "MemberExpression" && !isOutermostMember(node)) return false
    if (["CallExpression", "NewExpression"].includes(parent?.type) && parent.callee === node) return false
    if (parent?.type === "VariableDeclarator" && (parent.id === node || parent.init === node)) return false
    if (parent?.type === "AssignmentPattern" && parent.left === node) return false
    if (["ImportDefaultSpecifier", "ImportNamespaceSpecifier", "ImportSpecifier"].includes(parent?.type)) return false
    if (parent?.type === "MemberExpression") return false
    if (parent?.type === "Property" && parents.get(parent)?.type === "ObjectPattern") return false
    if (parent?.type === "Property" && parent.key === node && !parent.computed && parent.value !== node) return false
    if (parent?.type === "ExportSpecifier") return false
    if (parent?.type?.startsWith("TS")) return false
    return true
  }

  const locallyShadowsRoot = (node) => {
    let root = node
    while (root?.type === "MemberExpression") root = unwrapExpression(root.object)
    if (root?.type !== "Identifier") return false
    if (![...ambientPlatformObjects, ...ambientPlatformConstructors, ...ambientPlatformFunctions, "Date"].includes(root.name)) {
      return false
    }
    const variable = variableForIdentifier(root)
    return variable !== null && (variable.defs?.length ?? 0) > 0 && provenanceOfVariable(variable) === null
  }

  const isValueReference = (node) => {
    if (node.type !== "Identifier") return false
    const parent = parents.get(node)
    if (parent === undefined) return false
    if ([
      "ArrayPattern",
      "ImportDefaultSpecifier",
      "ImportNamespaceSpecifier",
      "ImportSpecifier",
      "ObjectPattern",
      "RestElement"
    ].includes(parent.type)) return false
    if (parent.type.startsWith("TS")) return false
    if (parent.type === "VariableDeclarator" && parent.id === node) return false
    if (functionTypes.has(parent.type) && parent.id === node) return false
    if (parent.type === "MemberExpression" && (parent.object === node || (!parent.computed && parent.property === node))) {
      return false
    }
    if ((parent.type === "CallExpression" || parent.type === "NewExpression") && parent.callee === node) return false
    if (parent.type === "Property" && parents.get(parent)?.type === "ObjectPattern") return false
    if (parent.type === "Property" && parent.key === node && !parent.computed && parent.value !== node) return false
    return true
  }

  const isPromiseTypeReference = (node) => {
    if (node.type !== "TSTypeReference") return false
    const typeName = node.typeName
    if (typeName.type !== "Identifier" || !["Promise", "PromiseLike"].includes(typeName.name)) return false
    const variable = variableForIdentifier(typeName)
    return variable === null || (variable.defs?.length ?? 0) === 0
  }

  const services = parserServices ?? sourceCode.parserServices
  const checker = services?.program?.getTypeChecker?.()
  const nodeMap = services?.esTreeNodeToTSNodeMap

  const typeAt = (node) => {
    if (checker === undefined || nodeMap?.get === undefined) return undefined
    try {
      return checker.getTypeAtLocation(nodeMap.get(node))
    } catch {
      return undefined
    }
  }

  const isPromiseLikeType = (type) => {
    if (type === undefined || checker === undefined) return false
    try {
      const rendered = checker.typeToString(type)
      if (rendered === "any" || rendered === "unknown") return false
      return checker.getPropertyOfType(type, "then") !== undefined
        && checker.getPromisedTypeOfPromise(type) !== undefined
    } catch {
      return false
    }
  }

  const returnsPromiseLike = (node) => {
    const type = typeAt(node)
    if (type === undefined || checker === undefined) return false
    try {
      return [...type.getCallSignatures(), ...type.getConstructSignatures()]
        .some((signature) => isPromiseLikeType(checker.getReturnTypeOfSignature(signature)))
    } catch {
      return false
    }
  }

  const isEffectType = (type) => {
    if (type === undefined || checker === undefined) return false
    if (type.isUnion?.() || type.isIntersection?.()) return type.types.some(isEffectType)
    try {
      const isEffectDeclaration = (declaration) => {
        const declarationFile = declaration.getSourceFile().fileName.replaceAll("\\", "/")
        return /\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?effect\//u.test(declarationFile)
      }
      return type.getProperties?.().some((property) =>
        property.getName() === "~effect/Effect" && property.declarations?.some(isEffectDeclaration)) ?? false
    } catch {
      return false
    }
  }

  const returnsEffect = (node) => {
    const type = typeAt(node)
    if (type === undefined || checker === undefined) return false
    try {
      return type.getCallSignatures().some((signature) => isEffectType(checker.getReturnTypeOfSignature(signature)))
    } catch {
      return false
    }
  }

  const isDirectlyExported = (declaration) => {
    let parent = parents.get(declaration)
    if (parent?.type === "VariableDeclaration") parent = parents.get(parent)
    return parent?.type === "ExportNamedDeclaration" || parent?.type === "ExportDefaultDeclaration"
  }

  const isExportedBinding = (declaration, identifier) => {
    if (isDirectlyExported(declaration)) return true
    if (identifier?.type !== "Identifier") return false
    const variable = variableForIdentifier(identifier)
    if (variable === null) return false
    return nodes.some((node) => (node.type === "ExportSpecifier"
      && parents.get(node)?.source == null
      && variableForIdentifier(node.local) === variable)
      || (node.type === "ExportDefaultDeclaration"
        && node.declaration.type === "Identifier"
        && variableForIdentifier(node.declaration) === variable))
  }

  const isDirectEffectFunctionWrapper = (node) => {
    const provenance = provenanceOfExpression(node)
    if (provenance === null) return false
    const match = provenance.match(/^(?:builder|wrapped):Effect:(.+)$/u)
    return match !== null && effectFunctionMethods.includes(match[1])
  }

  const patternBindings = (pattern) => {
    if (pattern.type === "Identifier") return [pattern]
    if (pattern.type === "AssignmentPattern") return patternBindings(pattern.left)
    if (pattern.type === "RestElement") return patternBindings(pattern.argument)
    if (pattern.type === "ArrayPattern") return pattern.elements.flatMap((element) =>
      element === null ? [] : patternBindings(element))
    if (pattern.type === "ObjectPattern") return pattern.properties.flatMap((property) =>
      property.type === "RestElement" ? patternBindings(property.argument) : patternBindings(property.value))
    return []
  }

  const isStaticallyKnownAggregate = (input, seen = new WeakSet()) => {
    const node = unwrapExpression(input)
    if (node === null || node === undefined) return false
    if (node.type === "ObjectExpression") {
      return node.properties.every((property) => property.type === "Property"
        ? objectPropertyName(property) !== undefined
        : isStaticallyKnownAggregate(property.argument, seen))
    }
    if (node.type !== "Identifier") return false
    const variable = variableForIdentifier(node)
    if (variable === null || seen.has(variable)) return false
    seen.add(variable)
    const definition = variable.defs?.find((candidate) => candidate.type === "Variable"
      && candidate.node.id.type === "Identifier")
    return definition !== undefined && isStaticallyKnownAggregate(definition.node.init, seen)
  }

  const sourceValueAtPath = (input, path, seen = new WeakSet()) => {
    const node = unwrapExpression(input)
    if (node === null || node === undefined) return undefined
    if (node.type === "Identifier") {
      const variable = variableForIdentifier(node)
      if (variable === null || seen.has(variable)) return undefined
      seen.add(variable)
      const functionDefinition = variable.defs?.find((candidate) => candidate.node?.type === "FunctionDeclaration")
      if (functionDefinition !== undefined) {
        return path.length === 0 ? functionDefinition.node : undefined
      }
      const definition = variable.defs?.find((candidate) => candidate.type === "Variable")
      if (definition === undefined) return undefined
      if (definition.node.id.type === "Identifier") {
        return sourceValueAtPath(definition.node.init, path, seen)
      }
      const bindingPath = destructuredPathFor(definition.node.id, variable.name)
      return bindingPath === undefined
        ? undefined
        : sourceValueAtPath(definition.node.init, [...bindingPath, ...path], seen)
    }
    if (node.type === "MemberExpression") {
      const member = memberName(node)
      return member === undefined ? undefined : sourceValueAtPath(node.object, [member, ...path], seen)
    }
    if (path.length === 0) return node
    if (node.type !== "ObjectExpression") return undefined
    for (let index = node.properties.length - 1; index >= 0; index -= 1) {
      const property = node.properties[index]
      if (property.type === "Property") {
        const key = objectPropertyName(property)
        if (key === undefined) return undefined
        if (key === path[0]) {
          return path.length === 1
            ? unwrapExpression(property.value)
            : sourceValueAtPath(property.value, path.slice(1), seen)
        }
        continue
      }
      if (property.type === "SpreadElement") {
        const spreadValue = sourceValueAtPath(property.argument, path, seen)
        if (spreadValue !== undefined) return spreadValue
        if (!isStaticallyKnownAggregate(property.argument)) return undefined
      }
    }
    return undefined
  }

  const isLocallyDefinedNonPromiseCall = (callee) => {
    const source = unwrapExpression(sourceValueAtPath(callee, []))
    return source !== undefined && functionTypes.has(source.type) && !returnsPromiseLike(source)
  }

  const isWrappedDestructuredBinding = (declarator, binding) => {
    const path = destructuredPathFor(declarator.id, binding.name)
    if (path === undefined) return false
    const source = sourceValueAtPath(declarator.init, path)
    return source !== undefined && isDirectEffectFunctionWrapper(source)
  }

  const hasExplicitPromiseType = (node) =>
    nodes.some((candidate) => isPromiseTypeReference(candidate) && contains(node, candidate))

  const hasExplicitPromiseReturn = (fn) =>
    fn.returnType !== undefined && hasExplicitPromiseType(fn.returnType)

  const hasDirectFunctionFinding = (node) => {
    let current = parents.get(node)
    while (current !== undefined) {
      if (functionTypes.has(current.type)) {
        if (!isDirectCallbackOutput(node, current)) return false
        return current.async === true
          || hasExplicitPromiseReturn(current)
          || (!isTryPromiseProducer(current) && returnsPromiseLike(current))
      }
      current = parents.get(current)
    }
    return false
  }

  const hasAuthoritativeCallFinding = (node, callee) => {
    if (runnerConstruct(callee) !== undefined) return true
    if (callee?.startsWith("dynamic:")) return true
    let nested = unwrapExpression(node.callee)
    while (nested?.type === "CallExpression") {
      if (runnerConstruct(provenanceOfExpression(nested.callee)) !== undefined) return true
      nested = unwrapExpression(nested.callee)
    }
    if (callee?.startsWith("platform-import:")) return true
    if (callee?.startsWith("global:Promise.")) {
      return nativePromiseStatics.includes(callee.slice("global:Promise.".length))
    }
    if (callee?.startsWith("global:")) {
      const path = callee.slice("global:".length)
      const root = path.split(".")[0]
      if (ambientPlatformFunctions.includes(path)
        || ambientPlatformObjects.includes(root)
        || isAmbientPlatformMember(path)) return true
    }
    return promiseChainMethodForCall(node) !== undefined
  }

  const rootIdentifierOf = (input) => {
    let node = unwrapExpression(input)
    while (node?.type === "MemberExpression") node = unwrapExpression(node.object)
    return node?.type === "Identifier" ? node : undefined
  }

  const classDefinesMethod = (node, method) => node.body.body.some((member) =>
    ["MethodDefinition", "PropertyDefinition", "TSAbstractMethodDefinition"].includes(member.type)
      && objectPropertyName(member) === method)

  const localValueDefinesMethod = (input, method, seen = new WeakSet()) => {
    const node = unwrapExpression(input)
    if (node === null || node === undefined) return false
    if (node.type === "ObjectExpression") {
      return node.properties.some((property) => property.type === "Property"
        && objectPropertyName(property) === method)
    }
    if (node.type === "NewExpression" && node.callee.type === "Identifier") {
      const variable = variableForIdentifier(node.callee)
      if (variable === null || seen.has(variable)) return false
      seen.add(variable)
      return variable.defs?.some((definition) => {
        if (["ClassDeclaration", "ClassExpression"].includes(definition.node?.type)) {
          return classDefinesMethod(definition.node, method)
        }
        return definition.type === "Variable"
          && definition.node.init?.type === "ClassExpression"
          && classDefinesMethod(definition.node.init, method)
      }) ?? false
    }
    if (node.type === "Identifier") {
      const variable = variableForIdentifier(node)
      if (variable === null || seen.has(variable)) return false
      seen.add(variable)
      return variable.defs?.some((definition) => definition.type === "Variable"
        && localValueDefinesMethod(definition.node.init, method, seen)) ?? false
    }
    return false
  }

  const isHostMethodTarget = (callee, method) => {
    if (locallyShadowsRoot(callee)) return false
    const target = unwrapExpression(callee.object)
    const provenance = provenanceOfExpression(target)
    if (provenance?.startsWith("global:") || provenance?.startsWith("platform-import:")) return true
    if (localValueDefinesMethod(target, method)) return false
    const root = rootIdentifierOf(target)
    const variable = root === undefined ? null : variableForIdentifier(root)
    if (root !== undefined && (variable === null || (variable.defs?.length ?? 0) === 0)) return true
    const type = typeAt(target)
    if (type !== undefined && checker !== undefined) {
      try {
        const property = checker.getPropertyOfType(type, method)
        const declarationsForProperty = property?.declarations ?? []
        if (declarationsForProperty.length > 0) {
          return declarationsForProperty.some((declaration) => {
            const declarationFile = declaration.getSourceFile().fileName.replaceAll("\\", "/")
            if (/\/typescript\/lib\/lib\.(?:dom|webworker)(?:\.[^/]+)?\.d\.ts$/u.test(declarationFile)) {
              return true
            }
            const nodeModules = declarationFile.lastIndexOf("/node_modules/")
            if (nodeModules < 0) return false
            const packagePath = declarationFile.slice(nodeModules + "/node_modules/".length)
            const segments = packagePath.split("/")
            const packageName = segments[0]?.startsWith("@")
              ? `${segments[0]}/${segments[1] ?? ""}`
              : segments[0]
            const runtimePackage = packageName?.startsWith("@types/")
              ? packageName.slice("@types/".length)
              : packageName
            return packageName === "@types/node"
              || (runtimePackage !== undefined && isPlatformPackage(runtimePackage))
          })
        }
      } catch {
        return true
      }
    }
    return true
  }

  const promiseLikeValueNode = (node) => {
    const value = node.type === "AccessorProperty" || node.type === "PropertyDefinition"
      ? node.value ?? node.typeAnnotation?.typeAnnotation
      : node.type === "TSAbstractPropertyDefinition" || node.type === "TSIndexSignature"
        || node.type === "TSPropertySignature"
        ? node.typeAnnotation?.typeAnnotation
        : node.typeAnnotation
    if (value === null || value === undefined || hasExplicitPromiseType(value)) return undefined
    if (value.type === "TSTypeReference" && value.typeName.type === "Identifier"
      && ["Promise", "PromiseLike"].includes(value.typeName.name)) {
      const variable = variableForIdentifier(value.typeName)
      if (variable !== null && (variable.defs?.length ?? 0) > 0) return undefined
    }
    return isPromiseLikeType(typeAt(value)) ? value : undefined
  }

  for (const node of nodes) declarations.add(declarationFor(node, parents, structuralNodes))

  for (const node of nodes) {
    if (functionTypes.has(node.type) && node.async === true) {
      add("nativeAsync", node, "native:async")
    }

    if (node.type === "AwaitExpression") add("nativeAwait", node, "native:await")

    if (isRunnerReference(node)) {
      const runner = runnerConstruct(provenanceOfExpression(node))
      if (runner !== undefined) add("runnerOutsideBoundary", node, runner)
    }

    if (isPlatformImportReference(node)) {
      const provenance = provenanceOfExpression(node)
      add("platformEffect", node, `platform-use:${provenance.slice("platform-import:".length)}`)
    }

    if (isValueReference(node)) {
      const provenance = provenanceOfExpression(node)
      if (provenance?.startsWith("global:")) {
        const name = provenance.slice("global:".length)
        const root = name.split(".")[0]
        if (ambientPlatformObjects.includes(root)
          || ambientPlatformFunctions.includes(name)
          || ambientPlatformConstructors.includes(name)
          || ["Date", "crypto", "performance"].includes(root)) {
          add("platformEffect", node, `platform:${name}`)
        }
      }
    }

    if (node.type === "MetaProperty") {
      const parent = parents.get(node)
      if (parent?.type !== "MemberExpression" || parent.object !== node) {
        add("platformEffect", node, "platform:import.meta")
      }
    }

    if (node.type === "ImportDeclaration" && typeof node.source.value === "string") {
      if ((isNodeBuiltin(node.source.value) || isPlatformPackage(node.source.value))
        && !isTypeOnlyImport(node)
        && !isDeterministicNodeUrlImport(node)) {
        add("platformEffect", node, `platform:import:${node.source.value}`)
      }
    }

    if (node.type === "TSImportEqualsDeclaration") {
      const source = node.moduleReference?.expression?.value
      if (node.importKind !== "type" && typeof source === "string"
        && (isNodeBuiltin(source) || isPlatformPackage(source))) {
        add("platformEffect", node, `platform:import:${source}`)
      }
    }

    if (node.type === "ImportExpression") {
      const source = staticStringValue(node.source)
      const platform = source !== undefined && (isNodeBuiltin(source) || isPlatformPackage(source))
      if (platform) add("platformEffect", node, `platform:import:${source}`)
      if (!platform && !isDirectTryPromiseConsumption(node) && !hasDirectFunctionFinding(node)) {
        add("promiseSignature", node, "promise-like:import")
      }
    }

    if (node.type === "NewExpression") {
      const callee = provenanceOfExpression(node.callee)
      if (callee?.startsWith("platform-import:") && !isDeterministicNodeUrlProvenance(callee)) {
        add("platformEffect", node, `platform-use:${callee.slice("platform-import:".length)}`)
      }
      if (callee === "global:Promise" && !isDirectTryPromiseConsumption(node)) {
        add("nativePromise", node, "promise:new")
      }
      const global = callee?.startsWith("global:") ? callee.slice("global:".length) : undefined
      if (global === "Date" || (global !== undefined && ambientPlatformConstructors.includes(global))) {
        add("platformEffect", node, `platform:new:${global}`)
      }
    }

    if (isPromiseTypeReference(node) && !isDirectTryPromiseConsumption(node)) {
      add("promiseSignature", node, `promise-type:${node.typeName.name}`)
    }

    if (node.type === "CallExpression") {
      const callee = provenanceOfExpression(node.callee)
      if (callee?.startsWith("dynamic:") && unwrapExpression(node.callee)?.type !== "MemberExpression") {
        addDynamicCapabilityFinding(node, callee.slice("dynamic:".length))
      }
      const effectNativeCall = isEffectType(typeAt(node))
      const invocationTarget = invocationHelperTarget(node.callee)
      const invocationProvenance = invocationTarget === undefined
        ? undefined
        : provenanceOfExpression(invocationTarget)
      const runner = runnerConstruct(callee)
      if (runner !== undefined) add("runnerOutsideBoundary", node, runner)
      const hostUrlMethod = hostUrlMethodFor(callee)
      if (hostUrlMethod !== undefined) add("platformEffect", node, `platform:URL.${hostUrlMethod}`)
      if (callee?.startsWith("platform-import:")
        && !isDeterministicNodeUrlProvenance(callee)
        && hostUrlMethod === undefined) {
        add("platformEffect", node, `platform-use:${callee.slice("platform-import:".length)}`)
      }

      if (!isDirectTryPromiseConsumption(node)
        && !hasDirectFunctionFinding(node)
        && !hasAuthoritativeCallFinding(node, callee)
        && !isLocallyDefinedNonPromiseCall(node.callee)
        && returnsPromiseLike(node.callee)) {
        add("promiseSignature", node, "promise-like:call")
      }

      if (callee?.startsWith("global:Promise.")) {
        const method = callee.slice("global:Promise.".length)
        if (nativePromiseStatics.includes(method) && !isDirectTryPromiseConsumption(node)) {
          add("nativePromise", node, `promise:Promise.${method}`)
        }
      }
      if (invocationProvenance === "global:Promise" && !isDirectTryPromiseConsumption(node)) {
        add("nativePromise", node, `promise:Promise.${memberName(node.callee)}`)
      }

      if (node.callee.type === "MemberExpression") {
        const method = memberName(node.callee)
        const chain = promiseChainMethodForCall(node)
        if (chain !== undefined && !callee?.startsWith("method:Effect:")) {
          add("promiseChain", node, `promise-chain:${chain}`)
        }
        if (!effectNativeCall && method !== undefined && listenerMethods.includes(method)
          && isHostMethodTarget(node.callee, method)) {
          add("platformEffect", node, `platform:listener:${method}`)
        }
        if (!effectNativeCall && method !== undefined && resourceMethods.includes(method)
          && isHostMethodTarget(node.callee, method)) {
          add("platformEffect", node, `platform:resource:${method}`)
        }
        if (invocationTarget?.type === "MemberExpression") {
          const targetMethod = memberName(invocationTarget)
          if (targetMethod !== undefined && listenerMethods.includes(targetMethod)
            && isHostMethodTarget(invocationTarget, targetMethod)) {
            add("platformEffect", node, `platform:listener:${targetMethod}`)
          }
          if (targetMethod !== undefined && resourceMethods.includes(targetMethod)
            && isHostMethodTarget(invocationTarget, targetMethod)) {
            add("platformEffect", node, `platform:resource:${targetMethod}`)
          }
        }
      }

      if (callee?.startsWith("global:")) {
        const path = callee.slice("global:".length)
        if (ambientPlatformFunctions.includes(path)
          || (node.callee.type !== "MemberExpression" && isAmbientPlatformMember(path))
          || path === "Date"
          || (invocationTarget !== undefined && ambientPlatformConstructors.includes(path))) {
          add("platformEffect", node, `platform:${path}`)
        }
        const source = staticStringValue(node.arguments[0])
        if (["require", "module.require"].includes(path)
          && source !== undefined
          && (isNodeBuiltin(source) || isPlatformPackage(source))
          && !isDeterministicNodeUrlRequire(node, source)) {
          add("platformEffect", node, `platform:import:${source}`)
        }
      }

      if (callee?.startsWith("schema-factory:")) {
        const method = callee.slice("schema-factory:".length)
        if (schemaSyncMethods.includes(method) && isWithinEffectCallback(node)) {
          add("syncSchemaInEffect", node, `schema:Schema.${method}`)
        }
      }
    }

    if (["ExportAllDeclaration", "ExportNamedDeclaration"].includes(node.type)
      && typeof node.source?.value === "string" && !isTypeOnlyExport(node)) {
      const source = node.source.value
      const runtimeSpecifiers = node.type === "ExportNamedDeclaration"
        ? node.specifiers.filter((specifier) => specifier.exportKind !== "type")
        : []
      const deterministicNodeUrl = ["node:url", "url"].includes(source)
        && runtimeSpecifiers.length > 0
        && runtimeSpecifiers.every((specifier) => specifier.type === "ExportSpecifier"
          && deterministicNodeUrlExports.includes(importName(specifier.local)))
      if ((isNodeBuiltin(source) || isPlatformPackage(source)) && !deterministicNodeUrl) {
        add("platformEffect", node, `platform:re-export:${source}`)
      }
      const base = requiredModuleProvenance(source)
      if (node.type === "ExportAllDeclaration") {
        const runner = runnerExportConstruct(base)
        if (runner !== undefined) add("runnerOutsideBoundary", node, runner)
      } else {
        for (const specifier of node.specifiers) {
          if (specifier.type !== "ExportSpecifier" || specifier.exportKind === "type") continue
          const provenance = provenanceAtMember(base, importName(specifier.local))
          const runner = runnerExportConstruct(provenance)
          if (runner !== undefined) add("runnerOutsideBoundary", specifier, runner)
        }
      }
    }

    if (node.type === "ExportNamedDeclaration" && node.source == null) {
      for (const specifier of node.specifiers) {
        if (specifier.type === "ExportSpecifier" && specifier.exportKind !== "type") {
          addExportedProvenance(specifier, provenanceOfExpression(specifier.local))
        }
      }
      if (node.declaration?.type === "VariableDeclaration") {
        for (const declarator of node.declaration.declarations) {
          for (const binding of patternBindings(declarator.id)) {
            addExportedProvenance(binding, provenanceOfIdentifier(binding))
          }
        }
      }
    }

    if (node.type === "ExportDefaultDeclaration") {
      addExportedProvenance(node.declaration, provenanceOfExpression(node.declaration))
    }

    if (node.type === "AssignmentExpression" && node.left.type === "MemberExpression") {
      const target = provenanceOfExpression(node.left)
      if (target === "global:module.exports" || target?.startsWith("global:exports.")) {
        addExportedProvenance(node.right, provenanceOfExpression(node.right))
      }
    }

    if (node.type === "MemberExpression" && isOutermostMember(node)) {
      const provenance = provenanceOfExpression(node)
      if (provenance?.startsWith("dynamic:")) {
        addDynamicCapabilityFinding(node, provenance.slice("dynamic:".length))
      }
      if (provenance?.startsWith("import-meta:") && provenance !== "import-meta:url") {
        add("platformEffect", node, `platform:import.meta.${provenance.slice("import-meta:".length)}`)
      }
      const path = globalPath(node)
      if (path !== undefined) {
        const root = path.split(".")[0]
        if (ambientPlatformObjects.includes(root) || isAmbientPlatformMember(path)) {
          add("platformEffect", node, `platform:${path}`)
        }
        if (isDirectCallableMemberReference(node)
          && (ambientPlatformFunctions.includes(path)
            || ambientPlatformConstructors.includes(path)
            || hostUrlMethodFor(provenance) !== undefined)) {
          add("platformEffect", node, `platform:${path}`)
        }
      }
    }

    if (checkerSignatureTypes.has(node.type) && !hasExplicitPromiseReturn(node) && returnsPromiseLike(node)) {
      add("promiseSignature", node, "promise-like:return")
    }

    if (checkerValueTypes.has(node.type)) {
      const value = promiseLikeValueNode(node)
      if (value !== undefined) {
        add("promiseSignature", node.type === "TSPropertySignature" ? node : value, "promise-like:value")
      }
    }

    if (functionTypes.has(node.type) && node.async !== true && node.body !== undefined
      && !hasExplicitPromiseReturn(node) && !isTryPromiseProducer(node)
      && returnsPromiseLike(node)) {
      add("promiseSignature", node, "promise-like:return")
    }
  }

  for (const node of nodes) {
    if ((node.type === "FunctionDeclaration" || node.type === "TSDeclareFunction")
      && isExportedBinding(node, node.id) && returnsEffect(node)) {
      add("effectFunctionBoundary", node, `effect-function:${node.id?.name ?? "default"}`)
    }
    if (node.type === "VariableDeclarator" && node.init !== null) {
      for (const binding of patternBindings(node.id)) {
        if (!isExportedBinding(node, binding) || !returnsEffect(binding)) continue
        const wrapped = node.id.type === "Identifier"
          ? isDirectEffectFunctionWrapper(node.init)
          : isWrappedDestructuredBinding(node, binding)
        if (!wrapped) {
          add("effectFunctionBoundary", node.id.type === "Identifier" ? unwrapExpression(node.init) : binding,
            `effect-function:${binding.name}`)
        }
      }
    }
  }

  candidates.sort((left, right) => {
    const leftRange = left.node.range ?? [0, 0]
    const rightRange = right.node.range ?? [0, 0]
    return leftRange[0] - rightRange[0] || leftRange[1] - rightRange[1]
      || left.messageId.localeCompare(right.messageId)
      || left.construct.localeCompare(right.construct)
  })

  const counts = new Map()
  const occurrences = candidates.map((candidate) => {
    const declaration = declarationFor(candidate.node, parents, structuralNodes)
    const key = `${declaration}\u0000${candidate.construct}`
    const occurrence = counts.get(key) ?? 0
    counts.set(key, occurrence + 1)
    const identity = { file, declaration, construct: candidate.construct, occurrence }
    occurrenceIdentities.set(candidate.node, identity)
    return Object.freeze({ messageId: candidate.messageId, identity: Object.freeze(identity), node: candidate.node })
  })

  const deepestNodeAt = (offset) => {
    let match = sourceCode.ast
    for (const node of nodes) {
      if (node.range === undefined || node.range[0] > offset || offset > node.range[1]) continue
      if (match.range === undefined || node.range[1] - node.range[0] <= match.range[1] - match.range[0]) match = node
    }
    return match
  }

  const occurrenceContaining = (offset) => {
    let match
    for (const occurrence of occurrences) {
      const range = occurrence.node.range
      if (range === undefined || range[0] > offset || offset > range[1]) continue
      if (match === undefined || range[1] - range[0] < match.node.range[1] - match.node.range[0]) match = occurrence
    }
    return match
  }

  const fallbackIdentity = (node, construct) => {
    const declaration = declarationFor(node, parents, structuralNodes)
    const start = node.range?.[0] ?? 0
    const occurrence = nodes.filter((candidate) => candidate.type === node.type
      && declarationFor(candidate, parents, structuralNodes) === declaration
      && (candidate.range?.[0] ?? 0) < start).length
    return Object.freeze({ file, declaration, construct, occurrence })
  }

  const identityOf = (node) => occurrenceIdentities.get(node)
    ?? fallbackIdentity(node, `syntax:${node?.type ?? "unknown"}`)

  const identityAtOffset = (offset, fallbackConstruct) => occurrenceContaining(offset)?.identity
    ?? fallbackIdentity(deepestNodeAt(offset), fallbackConstruct)

  return Object.freeze({
    occurrences: Object.freeze(occurrences),
    declarations: new Set(declarations),
    identityOf,
    identityAtOffset
  })
}
