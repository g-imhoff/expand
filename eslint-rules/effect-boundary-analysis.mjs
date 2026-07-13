import {
  ambientPlatformConstructors,
  ambientPlatformFunctions,
  ambientPlatformMembers,
  ambientPlatformObjects,
  effectCallbackMethods,
  effectFunctionMethods,
  effectRunnerMethods,
  isNodeBuiltin,
  isPlatformPackage,
  listenerMethods,
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
const transparentExpressionTypes = new Set([
  "ChainExpression",
  "TSAsExpression",
  "TSInstantiationExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion"
])
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
  nodes.sort((left, right) => {
    const leftRange = left.range ?? [0, 0]
    const rightRange = right.range ?? [0, 0]
    return leftRange[0] - rightRange[0] || leftRange[1] - rightRange[1]
  })
  return { nodes, parents }
}

const classNameFor = (node, parents) => {
  let current = node
  while (current !== undefined) {
    if (current.type === "ClassDeclaration" || current.type === "ClassExpression") {
      return current.id?.name ?? "<anonymous>"
    }
    current = parents.get(current)
  }
  return "<anonymous>"
}

const typeOwnerFor = (node, parents) => {
  let current = parents.get(node)
  while (current !== undefined) {
    if (current.type === "TSInterfaceDeclaration") return `interface:${current.id.name}`
    if (current.type === "TSTypeAliasDeclaration") return `type:${current.id.name}`
    if (current.type === "ClassDeclaration" || current.type === "ClassExpression") {
      return `class:${current.id?.name ?? "<anonymous>"}`
    }
    current = parents.get(current)
  }
  return "module:<module>"
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

const declarationFor = (node, parents) => {
  let current = node
  while (current !== undefined) {
    const parent = parents.get(current)
    if (current.type === "MethodDefinition" || current.type === "PropertyDefinition") {
      return `member:${classNameFor(current, parents)}.${propertyName(current.key) ?? "<computed>"}`
    }
    if (["TSCallSignatureDeclaration", "TSConstructSignatureDeclaration", "TSIndexSignature"].includes(current.type)) {
      return `${typeOwnerFor(current, parents)}.<signature>`
    }
    if (["TSMethodSignature", "TSPropertySignature"].includes(current.type)) {
      return `${typeOwnerFor(current, parents)}.${propertyName(current.key) ?? "<computed>"}`
    }
    if (current.type === "Property" && parent?.type === "ObjectExpression") {
      return `property:${variableOwnerForProperty(current, parents)}.${propertyName(current.key) ?? "<computed>"}`
    }
    if (current.type === "FunctionDeclaration" || current.type === "TSDeclareFunction") {
      return `function:${current.id?.name ?? "<anonymous>"}`
    }
    if (current.type === "FunctionExpression" && parent?.type !== "MethodDefinition") {
      if (current.id !== null && current.id !== undefined) return `function:${current.id.name}`
    }
    if (current.type === "VariableDeclarator") return `variable:${patternName(current.id)}`
    if (current.type === "ClassDeclaration") return `class:${current.id?.name ?? "<anonymous>"}`
    if (current.type === "TSInterfaceDeclaration") return `interface:${current.id.name}`
    if (current.type === "TSTypeAliasDeclaration") return `type:${current.id.name}`
    if (current.type === "TSEnumDeclaration") return `enum:${current.id.name}`
    if (current.type === "TSModuleDeclaration") return `namespace:${propertyName(current.id) ?? "<anonymous>"}`
    current = parent
  }
  return "module:<module>"
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
  const { nodes, parents } = collectTree(sourceCode.ast)
  const candidates = []
  const declarations = new Set(["module:<module>"])
  const variableCache = new WeakMap()
  const variableResolving = new WeakSet()
  const referenceVariables = new WeakMap()
  const occurrenceIdentities = new WeakMap()
  const reported = new Set()

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
    if (node.type === "Identifier") return provenanceOfIdentifier(node)
    if (node.type === "MemberExpression") {
      const base = provenanceOfExpression(node.object)
      const member = propertyName(node.property)
      if (base === null || member === undefined) return null
      if (base === "module:effect" && ["Effect", "ManagedRuntime", "Runtime", "Schema"].includes(member)) {
        return `namespace:${member}`
      }
      if (base === "module:@effect/platform-node" && member === "NodeRuntime") return "namespace:NodeRuntime"
      if (base.startsWith("namespace:")) return `method:${base.slice("namespace:".length)}:${member}`
      if (base === "instance:ManagedRuntime") return `method:ManagedRuntimeInstance:${member}`
      if (base.startsWith("global:")) return `${base}.${member}`
      if (base.startsWith("platform-import:")) return `${base}.${member}`
      return null
    }
    if (node.type === "CallExpression") {
      const callee = provenanceOfExpression(node.callee)
      if (callee === "method:ManagedRuntime:make") return "instance:ManagedRuntime"
      if (callee === "method:Runtime:make") return "instance:Runtime"
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

  const destructuredPropertyFor = (pattern, name) => {
    if (pattern.type !== "ObjectPattern") return undefined
    for (const property of pattern.properties) {
      if (property.type === "RestElement") continue
      const local = property.value.type === "AssignmentPattern" ? property.value.left : property.value
      if (patternName(local) === name) return propertyName(property.key)
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
        const declaration = parents.get(specifier)
        const source = declaration?.source?.value
        if (typeof source === "string") provenance = importProvenance(specifier, source)
      }
      if (definition.type === "Variable") {
        const declarator = definition.node
        if (declarator.id.type === "Identifier") {
          provenance = provenanceOfExpression(declarator.init)
        } else {
          const member = destructuredPropertyFor(declarator.id, variable.name)
          const base = provenanceOfExpression(declarator.init)
          if (member !== undefined && base !== null) {
            if (base === "module:effect" && ["Effect", "ManagedRuntime", "Runtime", "Schema"].includes(member)) {
              provenance = `namespace:${member}`
            }
            if (base === "module:@effect/platform-node" && member === "NodeRuntime") {
              provenance = "namespace:NodeRuntime"
            }
            if (base.startsWith("namespace:")) provenance = `method:${base.slice("namespace:".length)}:${member}`
            if (base === "instance:ManagedRuntime") provenance = `method:ManagedRuntimeInstance:${member}`
            if (base.startsWith("global:")) provenance = `${base}.${member}`
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

  const callbackOwner = (fn) => {
    const parent = parents.get(fn)
    if (parent?.type === "CallExpression" && parent.arguments.includes(fn)) return parent
    if (parent?.type === "Property") {
      const object = parents.get(parent)
      const call = parents.get(object)
      if (object?.type === "ObjectExpression" && call?.type === "CallExpression" && call.arguments.includes(object)) {
        return call
      }
    }
    return undefined
  }

  const isEffectCallback = (fn, requiredMethod) => {
    const call = callbackOwner(fn)
    if (call === undefined) return false
    const method = effectMethodForCall(call)
    if (method === undefined || !effectCallbackMethods.includes(method)) return false
    return requiredMethod === undefined || method === requiredMethod
  }

  const isWithinEffectCallback = (node) => {
    let current = parents.get(node)
    while (current !== undefined) {
      if (functionTypes.has(current.type) && isEffectCallback(current)) return true
      current = parents.get(current)
    }
    return false
  }

  const isReturnedByCallback = (node, fn) => {
    if (fn.returnType !== undefined && contains(fn.returnType, node)) return true
    if (fn.body.type !== "BlockStatement") return contains(fn.body, node)
    let current = node
    while (current !== undefined && current !== fn) {
      if (current.type === "ReturnStatement" && current.argument !== null && contains(current.argument, node)) return true
      current = parents.get(current)
    }
    return false
  }

  const isDirectTryPromiseConsumption = (node) => {
    let current = parents.get(node)
    while (current !== undefined) {
      if (functionTypes.has(current.type)) {
        return isEffectCallback(current, "tryPromise") && isReturnedByCallback(node, current)
      }
      current = parents.get(current)
    }
    return false
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
      if (runtimeRunnerMethods.includes(method)) return `runner:ManagedRuntime.${method}`
    }
    if (provenance?.startsWith("method:ManagedRuntimeInstance:")) {
      const method = provenance.slice("method:ManagedRuntimeInstance:".length)
      if (runtimeRunnerMethods.includes(method)) return `runner:ManagedRuntime.${method}`
    }
    if (provenance?.startsWith("method:NodeRuntime:")) {
      const method = provenance.slice("method:NodeRuntime:".length)
      if (nodeRuntimeRunnerMethods.includes(method)) return `runner:NodeRuntime.${method}`
    }
    return undefined
  }

  const globalPath = (node) => {
    const provenance = provenanceOfExpression(node)
    return provenance?.startsWith("global:") ? provenance.slice("global:".length) : undefined
  }

  const isOutermostMember = (node) => {
    const parent = parents.get(node)
    return parent?.type !== "MemberExpression" || parent.object !== node
  }

  const isRunnerReference = (node) => {
    if (node.type !== "Identifier" && node.type !== "MemberExpression") return false
    const parent = parents.get(node)
    if (parent?.type === "CallExpression" && parent.callee === node) return false
    if (parent?.type === "VariableDeclarator" && parent.init === node) return false
    if (node.type === "MemberExpression") return isOutermostMember(node)
    if (["ImportDefaultSpecifier", "ImportNamespaceSpecifier", "ImportSpecifier"].includes(parent?.type)) return false
    if (parent?.type === "MemberExpression" && parent.property === node && !parent.computed) return false
    if (parent?.type === "Property" && parents.get(parent)?.type === "ObjectPattern") return false
    if (parent?.type === "Property" && parent.key === node && !parent.computed && parent.value !== node) return false
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
      return checker.getPromisedTypeOfPromise(type) !== undefined
    } catch {
      return false
    }
  }

  const returnsPromiseLike = (node) => {
    const type = typeAt(node)
    if (type === undefined || checker === undefined) return false
    try {
      return type.getCallSignatures().some((signature) => isPromiseLikeType(checker.getReturnTypeOfSignature(signature)))
    } catch {
      return false
    }
  }

  const isEffectType = (type) => {
    if (type === undefined || checker === undefined) return false
    if (type.isUnion?.()) return type.types.some(isEffectType)
    try {
      if (type.getProperty?.("EffectTypeId") !== undefined) return true
      const rendered = checker.typeToString(type)
      return /(?:^|\.)Effect</u.test(rendered) && rendered.includes("<")
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

  const isExportedVariable = (declarator) => {
    const declaration = parents.get(declarator)
    const direct = parents.get(declaration)
    if (direct?.type === "ExportNamedDeclaration" || direct?.type === "ExportDefaultDeclaration") return true
    const variableName = patternName(declarator.id)
    return nodes.some((node) => node.type === "ExportSpecifier"
      && propertyName(node.local) === variableName
      && parents.get(node)?.source == null)
  }

  const variableDeclaratorForFunction = (fn) => {
    let current = fn
    while (current !== undefined) {
      const parent = parents.get(current)
      if (parent?.type === "VariableDeclarator" && parent.init !== null) return current === unwrapExpression(parent.init)
        ? parent
        : undefined
      if (parent !== undefined && !transparentExpressionTypes.has(parent.type)) return undefined
      if (parent?.type === "ExportDefaultDeclaration" || parent?.type === "Program") return undefined
      current = parent
    }
    return undefined
  }

  const containsEffectFunctionWrapper = (node) => nodes.some((candidate) => {
    if (candidate.type !== "CallExpression" || !contains(node, candidate)) return false
    const method = effectMethodForCall(candidate)
    return method !== undefined && effectFunctionMethods.includes(method)
  })

  const hasExplicitPromiseReturn = (fn) => {
    if (fn.returnType === undefined) return false
    return nodes.some((node) => isPromiseTypeReference(node) && contains(fn.returnType, node))
  }

  for (const node of nodes) declarations.add(declarationFor(node, parents))

  for (const node of nodes) {
    if (functionTypes.has(node.type) && node.async === true) {
      add("nativeAsync", node, "native:async")
    }

    if (node.type === "AwaitExpression") add("nativeAwait", node, "native:await")

    if (isRunnerReference(node)) {
      const runner = runnerConstruct(provenanceOfExpression(node))
      if (runner !== undefined) add("runnerOutsideBoundary", node, runner)
    }

    if (isValueReference(node)) {
      const provenance = provenanceOfExpression(node)
      if (provenance?.startsWith("global:")) {
        const name = provenance.slice("global:".length)
        if (ambientPlatformObjects.includes(name)
          || ambientPlatformFunctions.includes(name)
          || ambientPlatformConstructors.includes(name)
          || ["Date", "crypto", "performance"].includes(name)) {
          add("platformEffect", node, `platform:${name}`)
        }
      }
    }

    if (node.type === "ImportDeclaration" && typeof node.source.value === "string") {
      if (isNodeBuiltin(node.source.value) || isPlatformPackage(node.source.value)) {
        add("platformEffect", node, `platform:import:${node.source.value}`)
      }
    }

    if (node.type === "ImportExpression" && node.source.type === "Literal" && typeof node.source.value === "string") {
      if (isNodeBuiltin(node.source.value) || isPlatformPackage(node.source.value)) {
        add("platformEffect", node, `platform:import:${node.source.value}`)
      }
    }

    if (node.type === "NewExpression") {
      const callee = provenanceOfExpression(node.callee)
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
      const runner = runnerConstruct(callee)
      if (runner !== undefined) add("runnerOutsideBoundary", node, runner)

      if (callee?.startsWith("global:Promise.")) {
        const method = callee.slice("global:Promise.".length)
        if (nativePromiseStatics.includes(method) && !isDirectTryPromiseConsumption(node)) {
          add("nativePromise", node, `promise:Promise.${method}`)
        }
      }

      if (node.callee.type === "MemberExpression") {
        const method = propertyName(node.callee.property)
        if (method !== undefined && promiseChainMethods.includes(method)
          && !callee?.startsWith("method:Effect:")
          && !isDirectTryPromiseConsumption(node)) {
          add("promiseChain", node, `promise-chain:${method}`)
        }
        if (method !== undefined && listenerMethods.includes(method) && !locallyShadowsRoot(node.callee)) {
          add("platformEffect", node, `platform:listener:${method}`)
        }
        if (method !== undefined && resourceMethods.includes(method) && !locallyShadowsRoot(node.callee)) {
          add("platformEffect", node, `platform:resource:${method}`)
        }
      }

      if (callee?.startsWith("global:")) {
        const path = callee.slice("global:".length)
        if (ambientPlatformFunctions.includes(path) || path === "Date") {
          add("platformEffect", node, `platform:${path}`)
        }
        if (path === "require" && node.arguments[0]?.type === "Literal"
          && typeof node.arguments[0].value === "string"
          && (isNodeBuiltin(node.arguments[0].value) || isPlatformPackage(node.arguments[0].value))) {
          add("platformEffect", node, `platform:import:${node.arguments[0].value}`)
        }
      }

      if (callee?.startsWith("method:Schema:")) {
        const method = callee.slice("method:Schema:".length)
        if (schemaSyncMethods.includes(method) && isWithinEffectCallback(node)) {
          add("syncSchemaInEffect", node, `schema:Schema.${method}`)
        }
      }
    }

    if (node.type === "MemberExpression" && isOutermostMember(node)) {
      const path = globalPath(node)
      if (path !== undefined) {
        const root = path.split(".")[0]
        if (ambientPlatformObjects.includes(root) || ambientPlatformMembers.includes(path)) {
          add("platformEffect", node, `platform:${path}`)
        }
      }
    }

    if (functionTypes.has(node.type) && node.async !== true && node.body !== undefined
      && !hasExplicitPromiseReturn(node) && !isEffectCallback(node, "tryPromise")
      && returnsPromiseLike(node)) {
      add("promiseSignature", node, "promise-like:return")
    }
  }

  for (const node of nodes) {
    if (!functionTypes.has(node.type) || node.body === undefined || !returnsEffect(node)) continue
    if (node.type === "FunctionDeclaration") {
      const parent = parents.get(node)
      if (parent?.type === "ExportNamedDeclaration" || parent?.type === "ExportDefaultDeclaration") {
        add("effectFunctionBoundary", node, `effect-function:${node.id?.name ?? "default"}`)
      }
      continue
    }
    const declarator = variableDeclaratorForFunction(node)
    if (declarator === undefined || !isExportedVariable(declarator)) continue
    if (containsEffectFunctionWrapper(declarator.init)) continue
    add("effectFunctionBoundary", node, `effect-function:${patternName(declarator.id)}`)
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
    const declaration = declarationFor(candidate.node, parents)
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
    const declaration = declarationFor(node, parents)
    const start = node.range?.[0] ?? 0
    const occurrence = nodes.filter((candidate) => candidate.type === node.type
      && declarationFor(candidate, parents) === declaration
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
