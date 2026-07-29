import {
  browserResourceGlobals,
  effectCallbackMethods,
  effectProducerMethods,
  effectRunnerMethods,
  hostModules,
  listenerMethods,
  nodeBuiltinModules,
  platformConstructorGlobals,
  platformFunctionGlobals,
  processMembers,
  promiseChainMethods,
  promiseStaticMethods,
  runtimeRunnerMethods,
  schemaSyncMethods
} from "./effect-boundary-policy.mjs"

const promiseStatics = new Set(promiseStaticMethods)
const promiseChains = new Set(promiseChainMethods)
const effectRunners = new Set(effectRunnerMethods)
const runtimeRunners = new Set(runtimeRunnerMethods)
const effectCallbacks = new Set(effectCallbackMethods)
const effectProducers = new Set(effectProducerMethods)
const schemaSyncs = new Set(schemaSyncMethods)
const nodeBuiltins = new Set(nodeBuiltinModules)
const hostModuleNames = new Set(hostModules)
const processState = new Set(processMembers)
const platformFunctions = new Set(platformFunctionGlobals)
const platformConstructors = new Set(platformConstructorGlobals)
const browserResources = new Set(browserResourceGlobals)
const listeners = new Set(listenerMethods)
const declarationNodeTypes = new Set([
  "ClassDeclaration",
  "FunctionDeclaration",
  "MethodDefinition",
  "Property",
  "PropertyDefinition",
  "TSDeclareFunction",
  "TSEnumDeclaration",
  "TSInterfaceDeclaration",
  "TSMethodSignature",
  "TSPropertySignature",
  "TSTypeAliasDeclaration",
  "VariableDeclarator"
])
const effectPackageNamespaces = new Set(["Effect", "ManagedRuntime", "Runtime", "Schema"])
const listenerReceiverTypes = new Set(["BrowserWindow", "ChildProcess", "EventEmitter", "EventTarget", "MessagePort", "Socket", "WebSocket", "Worker"])
const repositoryRoot = decodeURIComponent(new URL("../", import.meta.url).pathname).replace(/\\/g, "/")

const isNode = (value) => value !== null && typeof value === "object" && typeof value.type === "string"
const startOf = (node) => Array.isArray(node?.range) ? node.range[0] : 0
const endOf = (node) => Array.isArray(node?.range) ? node.range[1] : startOf(node)
const containsOffset = (node, offset) => startOf(node) <= offset && offset <= endOf(node)
const memberName = (node) => {
  if (!node || (node.type !== "MemberExpression" && node.type !== "OptionalMemberExpression" && node.type !== "TSQualifiedName")) return undefined
  const property = node.type === "TSQualifiedName" ? node.right : node.property
  if (property?.type === "Identifier" || property?.type === "PrivateIdentifier") return property.name
  if (property?.type === "Literal") return typeof property.value === "string" || typeof property.value === "number" ? String(property.value) : undefined
  return undefined
}
const literalValue = (node) => node?.type === "Literal" && typeof node.value === "string" ? node.value : undefined
const bindingNames = (pattern) => {
  if (!pattern) return []
  if (pattern.type === "Identifier") return [pattern.name]
  if (pattern.type === "RestElement") return bindingNames(pattern.argument)
  if (pattern.type === "AssignmentPattern") return bindingNames(pattern.left)
  if (pattern.type === "ArrayPattern") return pattern.elements.flatMap(bindingNames)
  if (pattern.type === "ObjectPattern") return pattern.properties.flatMap((property) => property.type === "RestElement" ? bindingNames(property.argument) : bindingNames(property.value))
  return []
}
const propertyName = (node) => {
  if (!node) return "<computed>"
  if (node.type === "Identifier" || node.type === "PrivateIdentifier") return node.name
  if (node.type === "Literal") return String(node.value)
  return "<computed>"
}
const unwrap = (node) => {
  let current = node
  while (current && ["ChainExpression", "TSAsExpression", "TSInstantiationExpression", "TSNonNullExpression", "TSSatisfiesExpression", "TSTypeAssertion"].includes(current.type)) {
    current = current.expression
  }
  return current
}
const normalizeFilename = (filename) => {
  const normalized = decodeURIComponent(String(filename ?? "")).replace(/\\/g, "/")
  if (normalized.startsWith(repositoryRoot)) return normalized.slice(repositoryRoot.length)
  return normalized.replace(/^\.\//, "")
}
const origin = (root, path = [], module) => ({ root, path, module })
const appendOrigin = (value, name) => {
  if (!value || name === undefined) return undefined
  if (value.root === "Global" && value.path[0] === "globalThis") return origin("Global", [name], value.module)
  if (value.root === "EffectPackage" && value.path.length === 0 && effectPackageNamespaces.has(name)) return origin(name)
  if (value.root === "EffectPlatform" && value.path.length === 0 && name === "NodeRuntime") return origin("NodeRuntime")
  return origin(value.root, [...value.path, name], value.module)
}
const last = (values) => values.at(-1)

const canonicalImportOrigin = (moduleName, imported) => {
  const name = imported ?? "*"
  if (moduleName === "effect") {
    if (name === "*") return origin("EffectPackage")
    if (["Effect", "Schema", "Runtime", "ManagedRuntime"].includes(name)) return origin(name)
    return origin("EffectPackage", [name])
  }
  if (moduleName === "effect/Effect") return name === "*" || name === "default" ? origin("Effect") : origin("Effect", [name])
  if (moduleName === "effect/Schema") return name === "*" || name === "default" ? origin("Schema") : origin("Schema", [name])
  if (moduleName === "effect/Runtime") return name === "*" || name === "default" ? origin("Runtime") : origin("Runtime", [name])
  if (moduleName === "effect/ManagedRuntime") return name === "*" || name === "default" ? origin("ManagedRuntime") : origin("ManagedRuntime", [name])
  if (moduleName === "@effect/platform-node") {
    if (name === "NodeRuntime") return origin("NodeRuntime")
    return origin("EffectPlatform", name === "*" ? [] : [name], moduleName)
  }
  if (moduleName === "@effect/platform-node/NodeRuntime") return name === "*" || name === "default" ? origin("NodeRuntime") : origin("NodeRuntime", [name])
  if (isNodeBuiltinModule(moduleName)) return origin("NodeBuiltin", name === "*" ? [] : [name], moduleName)
  if (hostModuleNames.has(moduleName)) return origin("HostModule", name === "*" ? [] : [name], moduleName)
  return undefined
}

const isNodeBuiltinModule = (moduleName) => {
  if (typeof moduleName !== "string") return false
  const bare = moduleName.startsWith("node:") ? moduleName.slice(5) : moduleName
  return nodeBuiltins.has(bare.split("/")[0])
}

const collectNodes = (sourceCode) => {
  const nodes = []
  const parents = new WeakMap()
  const stack = [{ node: sourceCode.ast, parent: undefined }]
  while (stack.length > 0) {
    const entry = stack.pop()
    if (!isNode(entry?.node)) continue
    nodes.push(entry.node)
    if (entry.parent) parents.set(entry.node, entry.parent)
    const keys = sourceCode.visitorKeys?.[entry.node.type] ?? Object.keys(entry.node).filter((key) => !["parent", "range", "loc", "tokens", "comments"].includes(key))
    const children = []
    for (const key of keys) {
      const value = entry.node[key]
      if (Array.isArray(value)) {
        for (const child of value) if (isNode(child)) children.push(child)
      } else if (isNode(value)) {
        children.push(value)
      }
    }
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push({ node: children[index], parent: entry.node })
  }
  nodes.sort((left, right) => startOf(left) - startOf(right) || endOf(right) - endOf(left))
  return { nodes, parents }
}

const collectBindings = (sourceCode) => {
  const bindings = new WeakMap()
  for (const scope of sourceCode.scopeManager?.scopes ?? []) {
    for (const variable of scope.variables ?? []) {
      for (const identifier of variable.identifiers ?? []) bindings.set(identifier, variable)
    }
    for (const reference of scope.references ?? []) bindings.set(reference.identifier, reference.resolved ?? null)
    for (const reference of scope.through ?? []) if (!bindings.has(reference.identifier)) bindings.set(reference.identifier, reference.resolved ?? null)
  }
  return bindings
}

const pathInPattern = (pattern, target, path = []) => {
  if (!pattern) return undefined
  if (pattern.type === "Identifier") return pattern.name === target ? path : undefined
  if (pattern.type === "AssignmentPattern") return pathInPattern(pattern.left, target, path)
  if (pattern.type === "RestElement") return pathInPattern(pattern.argument, target, path)
  if (pattern.type === "ArrayPattern") {
    for (let index = 0; index < pattern.elements.length; index += 1) {
      const found = pathInPattern(pattern.elements[index], target, [...path, String(index)])
      if (found) return found
    }
  }
  if (pattern.type === "ObjectPattern") {
    for (const entry of pattern.properties) {
      if (entry.type === "RestElement") {
        const found = pathInPattern(entry.argument, target, path)
        if (found) return found
      } else {
        const found = pathInPattern(entry.value, target, [...path, propertyName(entry.key)])
        if (found) return found
      }
    }
  }
  return undefined
}

const isFunctionNode = (node) => [
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
  "TSCallSignatureDeclaration",
  "TSConstructSignatureDeclaration",
  "TSDeclareFunction",
  "TSFunctionType",
  "TSMethodSignature"
].includes(node?.type)

export const analyzeEffectBoundaryProgram = ({ filename, sourceCode, parserServices }) => {
  if (!sourceCode || !isNode(sourceCode.ast)) throw new TypeError("sourceCode must contain an ESTree program")
  const file = normalizeFilename(filename)
  const { nodes, parents } = collectNodes(sourceCode)
  const bindings = collectBindings(sourceCode)
  const variableOrigins = new WeakMap()
  const resolvingVariables = new WeakSet()
  const expressionOrigins = new WeakMap()
  const services = parserServices && typeof parserServices === "object" ? parserServices : sourceCode.parserServices
  const checker = services?.program?.getTypeChecker?.()
  const estreeToTs = services?.esTreeNodeToTSNodeMap
  const globalNames = new Set([
    "Date",
    "Math",
    "Promise",
    "PromiseLike",
    "console",
    "crypto",
    "globalThis",
    "performance",
    "process",
    "require",
    ...platformFunctions,
    ...platformConstructors,
    ...browserResources
  ])

  const originOfVariable = (variable) => {
    if (!variable) return undefined
    if (variableOrigins.has(variable)) return variableOrigins.get(variable)
    if (resolvingVariables.has(variable)) return undefined
    resolvingVariables.add(variable)
    let result
    for (const definition of variable.defs ?? []) {
      if (definition.type === "ImportBinding") {
        const specifier = definition.node
        const moduleName = literalValue(definition.parent?.source)
        const imported = specifier.type === "ImportNamespaceSpecifier"
          ? "*"
          : specifier.type === "ImportDefaultSpecifier"
            ? "default"
            : propertyName(specifier.imported)
        result = canonicalImportOrigin(moduleName, imported)
      } else if (definition.type === "Variable" && definition.node?.type === "VariableDeclarator") {
        const localName = variable.name
        const path = pathInPattern(definition.node.id, localName)
        const initial = originOfExpression(definition.node.init)
        result = path?.reduce((current, segment) => appendOrigin(current, segment), initial)
      }
      if (result) break
    }
    resolvingVariables.delete(variable)
    variableOrigins.set(variable, result)
    return result
  }

  const originOfIdentifier = (node) => {
    if (bindings.has(node)) {
      const variable = bindings.get(node)
      if (variable) {
        const resolved = originOfVariable(variable)
        if (resolved) return resolved
        if ((variable.defs ?? []).length > 0) return undefined
      }
    }
    return globalNames.has(node.name) ? origin("Global", [node.name]) : undefined
  }

  function originOfExpression(input) {
    const node = unwrap(input)
    if (!node) return undefined
    if (expressionOrigins.has(node)) return expressionOrigins.get(node)
    let result
    if (node.type === "Identifier") {
      result = originOfIdentifier(node)
    } else if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") {
      result = appendOrigin(originOfExpression(node.object), memberName(node))
    } else if (node.type === "TSQualifiedName") {
      result = appendOrigin(originOfExpression(node.left), memberName(node))
    } else if (node.type === "CallExpression" || node.type === "NewExpression") {
      const callee = originOfExpression(node.callee)
      const method = last(callee?.path ?? [])
      if (callee?.root === "ManagedRuntime" && method === "make") result = origin("ManagedRuntimeInstance")
      else if (callee?.root === "Runtime" && method === "make") result = origin("RuntimeInstance")
      else if (callee?.root === "Effect" && method === "runtime") result = origin("RuntimeInstance")
      else if (callee?.root === "Effect" && (effectCallbacks.has(method) || effectProducers.has(method) || effectRunners.has(method))) result = callee
      else if (["Runtime", "RuntimeInstance", "ManagedRuntime", "ManagedRuntimeInstance"].includes(callee?.root) && runtimeRunners.has(method)) result = callee
    }
    expressionOrigins.set(node, result)
    return result
  }

  const ownerName = (node) => {
    let current = parents.get(node)
    while (current) {
      if (current.type === "ClassDeclaration" || current.type === "ClassExpression") return current.id?.name ?? "<anonymous>"
      if (current.type === "TSInterfaceDeclaration" || current.type === "TSTypeAliasDeclaration") return current.id.name
      if (current.type === "VariableDeclarator") return bindingNames(current.id).join(",") || "<anonymous>"
      current = parents.get(current)
    }
    return "<anonymous>"
  }

  const declarationOf = (node) => {
    let current = node
    while (current) {
      if (current.type === "VariableDeclarator") return `variable:${bindingNames(current.id).join(",") || "<anonymous>"}`
      if (current.type === "FunctionDeclaration" || current.type === "TSDeclareFunction") return `function:${current.id?.name ?? "<anonymous>"}`
      if (current.type === "MethodDefinition" || current.type === "PropertyDefinition" || current.type === "AccessorProperty") {
        return `member:${ownerName(current)}.${propertyName(current.key)}`
      }
      if (current.type === "Property" && parents.get(current)?.type !== "ObjectPattern") return `member:${ownerName(current)}.${propertyName(current.key)}`
      if (current.type === "TSMethodSignature" || current.type === "TSPropertySignature") return `member:${ownerName(current)}.${propertyName(current.key)}`
      if (current.type === "TSTypeAliasDeclaration") return `type:${current.id.name}`
      if (current.type === "TSInterfaceDeclaration") return `interface:${current.id.name}`
      if (current.type === "TSEnumDeclaration") return `enum:${current.id.name}`
      if (current.type === "ClassDeclaration") return `class:${current.id?.name ?? "<anonymous>"}`
      current = parents.get(current)
    }
    return "module:<module>"
  }

  const declarations = new Set(["module:<module>"])
  for (const node of nodes) {
    if (declarationNodeTypes.has(node.type)) declarations.add(declarationOf(node))
  }

  const rawOccurrences = []
  const rawKeys = new Set()
  const addOccurrence = (node, messageId, construct) => {
    const key = `${startOf(node)}\u0000${endOf(node)}\u0000${messageId}\u0000${construct}`
    if (rawKeys.has(key)) return
    rawKeys.add(key)
    rawOccurrences.push({ node, messageId, construct })
  }

  const callbackOrigin = (functionNode) => {
    let current = functionNode
    let parent = parents.get(current)
    while (parent && ["TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression", "TSTypeAssertion"].includes(parent.type)) {
      current = parent
      parent = parents.get(current)
    }
    if (parent?.type !== "CallExpression" || !parent.arguments.includes(current)) return undefined
    const calleeOrigin = originOfExpression(parent.callee)
    return calleeOrigin?.root === "Effect" && effectCallbacks.has(last(calleeOrigin.path)) ? calleeOrigin : undefined
  }

  const insideCallback = (node, method) => {
    let current = parents.get(node)
    while (current) {
      if (isFunctionNode(current)) {
        const value = callbackOrigin(current)
        if (value && (method === undefined || last(value.path) === method)) return true
      }
      current = parents.get(current)
    }
    return false
  }

  const nearestFunction = (node) => {
    let current = parents.get(node)
    while (current) {
      if (isFunctionNode(current)) return current
      current = parents.get(current)
    }
    return undefined
  }

  const typeAt = (node) => {
    if (!checker || !estreeToTs?.get) return undefined
    try {
      const tsNode = estreeToTs.get(node)
      return tsNode ? checker.getTypeAtLocation(tsNode) : undefined
    } catch {
      return undefined
    }
  }

  const returnTypeOf = (node) => {
    if (!checker || !estreeToTs?.get) return undefined
    try {
      const tsNode = estreeToTs.get(node)
      if (!tsNode) return undefined
      const signature = checker.getSignatureFromDeclaration(tsNode) ?? checker.getTypeAtLocation(tsNode).getCallSignatures?.()[0]
      return signature ? checker.getReturnTypeOfSignature(signature) : undefined
    } catch {
      return undefined
    }
  }

  const isPromiseLikeType = (type) => {
    if (!type || !checker) return false
    try {
      if (checker.getPromisedTypeOfPromise(type)) return true
    } catch {
    }
    try {
      const thenMember = type.getProperty?.("then")
      const declaration = thenMember?.valueDeclaration ?? thenMember?.declarations?.[0]
      if (!thenMember || !declaration) return false
      return checker.getTypeOfSymbolAtLocation(thenMember, declaration).getCallSignatures?.().length > 0
    } catch {
      return false
    }
  }

  const isEffectType = (type) => {
    if (!type) return false
    for (const symbol of [type.aliasSymbol, type.symbol, type.target?.aliasSymbol, type.target?.symbol]) {
      if (!symbol) continue
      for (const declaration of symbol.declarations ?? []) {
        const sourceName = declaration.getSourceFile?.().fileName?.replace(/\\/g, "/") ?? ""
        if (sourceName.includes("/node_modules/effect/") && /Effect/.test(symbol.name)) return true
      }
    }
    for (const part of type.types ?? []) if (part !== type && isEffectType(part)) return true
    return false
  }

  const exportedNames = new Set()
  for (const statement of sourceCode.ast.body ?? []) {
    const declarationName = statement.declaration?.id?.name
    if (statement.type === "ExportNamedDeclaration") {
      if (statement.declaration?.type === "VariableDeclaration") {
        for (const declarator of statement.declaration.declarations) for (const name of bindingNames(declarator.id)) exportedNames.add(name)
      } else if (declarationName) {
        exportedNames.add(declarationName)
      }
      for (const specifier of statement.specifiers ?? []) if (specifier.local?.name) exportedNames.add(specifier.local.name)
    } else if (statement.type === "ExportDefaultDeclaration" && declarationName) {
      exportedNames.add(declarationName)
    }
  }

  const namedExportOfFunction = (functionNode) => {
    if (functionNode.type === "FunctionDeclaration" || functionNode.type === "TSDeclareFunction") {
      return functionNode.id?.name && exportedNames.has(functionNode.id.name) ? functionNode.id.name : undefined
    }
    let current = functionNode
    let parent = parents.get(current)
    while (parent && ["TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression", "TSTypeAssertion"].includes(parent.type)) {
      current = parent
      parent = parents.get(current)
    }
    if (parent?.type === "VariableDeclarator" && parent.init === current) {
      const names = bindingNames(parent.id)
      return names.length === 1 && exportedNames.has(names[0]) ? names[0] : undefined
    }
    if (parent?.type === "Property" && parent.value === current) {
      const object = parents.get(parent)
      const declarator = object?.type === "ObjectExpression" ? parents.get(object) : undefined
      const names = declarator?.type === "VariableDeclarator" ? bindingNames(declarator.id) : []
      if (names.length === 1 && exportedNames.has(names[0])) return `${names[0]}.${propertyName(parent.key)}`
    }
    if (parent?.type === "MethodDefinition") {
      const classBody = parents.get(parent)
      const classNode = classBody?.type === "ClassBody" ? parents.get(classBody) : undefined
      if (classNode?.id?.name && exportedNames.has(classNode.id.name)) return `${classNode.id.name}.${propertyName(parent.key)}`
    }
    return undefined
  }

  const expressionReturnsEffect = (expression) => {
    const node = unwrap(expression)
    if (!node) return false
    if (node.type === "CallExpression" || node.type === "NewExpression") {
      const callee = originOfExpression(node.callee)
      if (["ManagedRuntime", "ManagedRuntimeInstance", "Runtime", "RuntimeInstance"].includes(callee?.root)) return false
      if (checker) return isEffectType(typeAt(node))
      if (callee?.root === "Effect" && effectProducers.has(last(callee.path))) return true
    }
    return isEffectType(typeAt(node))
  }

  const functionReturnsEffect = (functionNode) => {
    if (isEffectType(returnTypeOf(functionNode))) return true
    if (functionNode.returnType) {
      const annotation = functionNode.returnType.typeAnnotation ?? functionNode.returnType
      const annotationOrigin = originOfExpression(annotation.typeName ?? annotation)
      if (annotationOrigin?.root === "Effect") return true
    }
    if (functionNode.type === "ArrowFunctionExpression" && functionNode.expression && expressionReturnsEffect(functionNode.body)) return true
    for (const node of nodes) {
      if (node.type === "ReturnStatement" && nearestFunction(node) === functionNode && expressionReturnsEffect(node.argument)) return true
    }
    return false
  }

  const promiseFunctionNodes = new Set()
  for (const node of nodes) {
    if (!isFunctionNode(node)) continue
    if (node.async) addOccurrence(node, "nativeAsync", "native:async")
    if (!node.async && last(callbackOrigin(node)?.path ?? []) !== "tryPromise" && isPromiseLikeType(returnTypeOf(node))) {
      promiseFunctionNodes.add(node)
      addOccurrence(node, "promiseSignature", "signature:PromiseLike")
    }
    const exportedName = namedExportOfFunction(node)
    if (exportedName && functionReturnsEffect(node) && last(callbackOrigin(node)?.path ?? []) !== "fn" && last(callbackOrigin(node)?.path ?? []) !== "fnUntraced") {
      addOccurrence(node, "effectFunctionBoundary", `effect-function:${exportedName}`)
    }
  }

  const typeReferenceInsideReportedFunction = (node) => {
    let current = parents.get(node)
    while (current) {
      if (isFunctionNode(current)) return promiseFunctionNodes.has(current)
      current = parents.get(current)
    }
    return false
  }

  const runnerOf = (value) => {
    if (!value) return undefined
    const method = last(value.path)
    if (value.root === "Effect" && effectRunners.has(method)) return { owner: "Effect", method }
    if (["Runtime", "RuntimeInstance"].includes(value.root) && runtimeRunners.has(method)) return { owner: "Runtime", method }
    if (["ManagedRuntime", "ManagedRuntimeInstance"].includes(value.root) && runtimeRunners.has(method)) return { owner: "ManagedRuntime", method }
    if (value.root === "NodeRuntime" && method === "runMain") return { owner: "NodeRuntime", method }
    return undefined
  }

  const isListenerReceiverType = (type, seen = new Set()) => {
    if (!type || seen.has(type)) return false
    seen.add(type)
    for (const symbol of [type.aliasSymbol, type.symbol, type.target?.aliasSymbol, type.target?.symbol]) {
      const name = symbol?.name ?? ""
      if (!listenerReceiverTypes.has(name) && !/ipc/i.test(name)) continue
      if ((symbol.declarations ?? []).some((declaration) => declaration.getSourceFile?.().fileName?.replace(/\\/g, "/").includes("/node_modules/"))) return true
    }
    for (const part of type.types ?? []) if (isListenerReceiverType(part, seen)) return true
    try {
      for (const base of type.getBaseTypes?.() ?? []) if (isListenerReceiverType(base, seen)) return true
    } catch {
    }
    return false
  }

  const platformOf = (value, objectNode, syntacticMethod) => {
    const method = syntacticMethod ?? last(value?.path ?? [])
    if (listeners.has(method) && checker && objectNode && isListenerReceiverType(typeAt(objectNode))) return `platform:listener.${method}`
    if (!value) return undefined
    if (value.root === "Global") {
      const [rootName, globalMethod] = value.path
      if (rootName === "process" && (globalMethod === undefined || processState.has(globalMethod) || listeners.has(last(value.path)))) return `platform:process${globalMethod ? `.${globalMethod}` : ""}`
      if (rootName === "console") return `platform:console${globalMethod ? `.${globalMethod}` : ""}`
      if (rootName === "Date") return `platform:Date${globalMethod ? `.${globalMethod}` : ""}`
      if (rootName === "performance") return `platform:performance${globalMethod ? `.${globalMethod}` : ""}`
      if (rootName === "Math" && globalMethod === "random") return "platform:Math.random"
      if (rootName === "crypto" && [undefined, "getRandomValues", "randomUUID", "subtle"].includes(globalMethod)) return `platform:crypto${globalMethod ? `.${globalMethod}` : ""}`
      if (platformFunctions.has(rootName)) return `platform:${rootName}`
      if (platformConstructors.has(rootName)) return `platform:${rootName}`
      if (browserResources.has(rootName)) return `platform:${rootName}${globalMethod ? `.${globalMethod}` : ""}`
    }
    if (value.root === "HostModule") return `platform:${value.module}${value.path.length > 0 ? `.${value.path.join(".")}` : ""}`
    return undefined
  }

  for (const node of nodes) {
    if (node.type === "AwaitExpression" || (node.type === "ForOfStatement" && node.await)) addOccurrence(node, "nativeAwait", "native:await")

    if (node.type === "TSTypeReference") {
      const value = originOfExpression(node.typeName)
      if (value?.root === "Global" && ["Promise", "PromiseLike"].includes(value.path[0]) && !typeReferenceInsideReportedFunction(node)) {
        addOccurrence(node, "promiseSignature", `signature:${value.path[0]}`)
      }
    }

    if (node.type === "ImportDeclaration") {
      const moduleName = literalValue(node.source)
      if (isNodeBuiltinModule(moduleName) || hostModuleNames.has(moduleName)) addOccurrence(node, "platformEffect", `platform:import:${moduleName}`)
    }

    if (node.type === "ImportExpression") {
      const moduleName = literalValue(node.source)
      if (isNodeBuiltinModule(moduleName) || hostModuleNames.has(moduleName)) addOccurrence(node, "platformEffect", `platform:import:${moduleName}`)
    }

    if (node.type === "NewExpression") {
      const callee = originOfExpression(node.callee)
      if (callee?.root === "Global" && callee.path[0] === "Promise") addOccurrence(node, "nativePromise", "promise:new")
      const platform = platformOf(callee, node.callee)
      if (platform) addOccurrence(node, "platformEffect", platform)
    }

    if (node.type === "CallExpression") {
      const callee = originOfExpression(node.callee)
      const calleeMethod = last(callee?.path ?? [])
      if (callee?.root === "Global" && callee.path[0] === "Promise" && (callee.path.length === 1 || promiseStatics.has(calleeMethod))) {
        addOccurrence(node, "nativePromise", `promise:${calleeMethod ?? "call"}`)
      }
      const syntacticMethod = memberName(unwrap(node.callee))
      if (promiseChains.has(syntacticMethod) && callee?.root !== "Effect" && !insideCallback(node, "tryPromise")) {
        addOccurrence(node, "promiseChain", `promise-chain:${syntacticMethod}`)
      }
      const runner = runnerOf(callee)
      const parent = parents.get(node)
      if (runner && !(parent?.type === "CallExpression" && parent.callee === node)) {
        addOccurrence(node, "runnerOutsideBoundary", `runner:${runner.owner}.${runner.method}`)
      }
      if (callee?.root === "Schema" && schemaSyncs.has(calleeMethod) && insideCallback(node)) {
        addOccurrence(node, "syncSchemaInEffect", `schema:Schema.${calleeMethod}`)
      }
      if (callee?.root === "Global" && callee.path[0] === "require") {
        const moduleName = literalValue(node.arguments[0])
        if (isNodeBuiltinModule(moduleName) || hostModuleNames.has(moduleName)) addOccurrence(node, "platformEffect", `platform:import:${moduleName}`)
      }
      const platform = platformOf(callee, unwrap(node.callee)?.object, syntacticMethod)
      if (platform) addOccurrence(node, "platformEffect", platform)
    }

    if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") {
      const parent = parents.get(node)
      const usedAsCallee = parent?.type === "CallExpression" && parent.callee === node
      const nestedObject = (parent?.type === "MemberExpression" || parent?.type === "OptionalMemberExpression") && parent.object === node
      const value = originOfExpression(node)
      const runner = runnerOf(value)
      const aliasInitializer = parent?.type === "VariableDeclarator" && parent.init === node
      if (runner && !usedAsCallee && !nestedObject && !aliasInitializer) addOccurrence(node, "runnerOutsideBoundary", `runner:${runner.owner}.${runner.method}`)
      if (!usedAsCallee && !nestedObject) {
        const platform = platformOf(value, node.object, memberName(node))
        if (platform) addOccurrence(node, "platformEffect", platform)
      }
    }
  }

  rawOccurrences.sort((left, right) => startOf(left.node) - startOf(right.node) || endOf(left.node) - endOf(right.node) || left.construct.localeCompare(right.construct))
  const counts = new Map()
  const occurrenceByNode = new WeakMap()
  const occurrences = rawOccurrences.map((entry) => {
    const declaration = declarationOf(entry.node)
    const key = `${declaration}\u0000${entry.construct}`
    const occurrence = counts.get(key) ?? 0
    counts.set(key, occurrence + 1)
    const identity = Object.freeze({ file, declaration, construct: entry.construct, occurrence })
    const value = Object.freeze({ messageId: entry.messageId, identity, node: entry.node })
    if (!occurrenceByNode.has(entry.node)) occurrenceByNode.set(entry.node, value)
    return value
  })

  const genericIdentities = new WeakMap()
  const genericCounts = new Map()
  for (const node of nodes) {
    const declaration = declarationOf(node)
    const construct = `syntax:${node.type}`
    const key = `${declaration}\u0000${construct}`
    const occurrence = genericCounts.get(key) ?? 0
    genericCounts.set(key, occurrence + 1)
    genericIdentities.set(node, Object.freeze({ file, declaration, construct, occurrence }))
  }

  const identityOf = (input) => {
    const node = isNode(input) ? input : sourceCode.ast
    return occurrenceByNode.get(node)?.identity ?? genericIdentities.get(node) ?? Object.freeze({ file, declaration: "module:<module>", construct: "syntax:unknown", occurrence: 0 })
  }

  const fallbackOccurrenceOf = (selected, construct) => {
    const declaration = declarationOf(selected)
    let occurrence = counts.get(`${declaration}\u0000${construct}`) ?? 0
    for (const node of nodes) {
      if (node === selected) break
      if (declarationOf(node) === declaration) occurrence += 1
    }
    return occurrence
  }

  const identityAtOffset = (offset, fallbackConstruct) => {
    const boundedOffset = Number.isFinite(offset) ? Math.max(0, offset) : 0
    let selected = sourceCode.ast
    for (const node of nodes) {
      if (containsOffset(node, boundedOffset) && endOf(node) - startOf(node) <= endOf(selected) - startOf(selected)) selected = node
    }
    const direct = occurrenceByNode.get(selected)?.identity
    if (direct?.construct === fallbackConstruct) return direct
    return Object.freeze({
      file,
      declaration: declarationOf(selected),
      construct: fallbackConstruct,
      occurrence: fallbackOccurrenceOf(selected, fallbackConstruct)
    })
  }

  return Object.freeze({
    occurrences: Object.freeze(occurrences),
    declarations,
    identityOf,
    identityAtOffset
  })
}
