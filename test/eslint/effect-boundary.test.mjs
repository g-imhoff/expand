import { RuleTester } from "eslint"
import tseslint from "typescript-eslint"
import { describe, it } from "vitest"
import { effectBoundary } from "../../eslint-rules/effect-boundary.mjs"

RuleTester.describe = describe
RuleTester.it = it
RuleTester.itOnly = it.only

const repositoryRoot = new URL("../../", import.meta.url)
const absolute = (relative) => new URL(relative, repositoryRoot).pathname
const validCase = (code) => ({ filename: absolute("effect-boundary-valid.ts"), code })
const invalidCase = (code, errors) => ({ filename: absolute("effect-boundary-invalid.ts"), code, errors })
const withBoundaries = (testCase, boundaries) => ({ ...testCase, options: [boundaries] })
const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      projectService: {
        allowDefaultProject: ["effect-boundary-valid.ts", "effect-boundary-invalid.ts"]
      },
      tsconfigRootDir: repositoryRoot.pathname
    }
  }
})
const runRuleTester = (valid, invalid) =>
  ruleTester.run("effect-boundary", effectBoundary, { valid, invalid })

const runnerBoundary = {
  file: "effect-boundary-valid.ts",
  declaration: "module:<module>",
  host: "Test application entrypoint",
  construct: "runner:Effect.runPromise",
  occurrence: 0
}
const scopedProcessBoundaries = ["first", "second"].map((scope) => ({
  file: "effect-boundary-valid.ts",
  declaration: `function:${scope}/variable:task`,
  host: `Test ${scope} lexical scope`,
  construct: "platform:process.env.HOME",
  occurrence: 0
}))
const anonymousAndBlockBoundaries = [
  ["scope:anonymous:call:member:identifier:items:map:argument:0:0/variable:task", "First anonymous callback"],
  ["scope:anonymous:call:member:identifier:items:filter:argument:0:0/variable:task", "Second anonymous callback"],
  ["scope:block:Program:body:0/variable:task", "First lexical block"],
  ["scope:block:Program:body:1/variable:task", "Second lexical block"]
].map(([declaration, host]) => ({
  file: "effect-boundary-valid.ts",
  declaration,
  host,
  construct: "platform:process.env.HOME",
  occurrence: 0
}))
const ownedAnonymousBoundaries = [
  [
    "variable:producer/scope:anonymous:VariableDeclarator:init:variable:producer:0/variable:task",
    "Owned variable initializer"
  ],
  [
    "property:handlers.load/scope:anonymous:Property:value:property:handlers.load:0/variable:task",
    "Owned object property"
  ]
].map(([declaration, host]) => ({
  file: "effect-boundary-valid.ts",
  declaration,
  host,
  construct: "platform:process.env.HOME",
  occurrence: 0
}))
const templatePropertyBoundary = {
  file: "effect-boundary-valid.ts",
  declaration: "property:handlers.load/scope:anonymous:Property:value:property:handlers.load:0/variable:task",
  host: "Static template property callback",
  construct: "platform:process.env.HOME",
  occurrence: 0
}
const classFieldBoundary = {
  file: "effect-boundary-valid.ts",
  declaration: "member:Handlers.load/scope:anonymous:PropertyDefinition:value:member:Handlers.load:0/variable:task",
  host: "Owned class field callback",
  construct: "platform:process.env.HOME",
  occurrence: 0
}

const valid = [
  validCase('import { Effect } from "effect"\nexport const load = Effect.fn("load")(function*() { return yield* Effect.tryPromise(() => host()) })'),
  validCase('import { Effect as Fx } from "effect"\nconst traced = Fx.fn\nexport const load = traced("load")(function*() { return yield* Fx.succeed(1) })'),
  validCase('import * as Fx from "effect/Effect"\nconst untraced = Fx.fnUntraced\nexport const load = untraced(function*() { return yield* Fx.succeed(1) })'),
  validCase('import { Effect } from "effect"\nEffect.tryPromise(() => new Promise((resolve) => resolve(1)))'),
  validCase('import { Effect } from "effect"\nEffect.tryPromise(() => Promise.resolve(1))'),
  validCase('import { Effect } from "effect"\nEffect.tryPromise((): Promise<string> => host())'),
  validCase([
    'import { Effect } from "effect"',
    "function conditional(flag) { return flag ? Promise.resolve(1) : Promise.reject(failure) }",
    "const sequenced = () => (prepare(), Promise.resolve(2))",
    "const objectTry = () => Promise.resolve(3)",
    "Effect.tryPromise(conditional)",
    "Effect.tryPromise(sequenced)",
    "Effect.tryPromise({ try: objectTry, catch: identity })"
  ].join("\n")),
  validCase([
    'import { Effect } from "effect"',
    "const produce = () => Promise.resolve(1)",
    "const handlers = { try: produce, catch: identity }",
    "const empty = { value: 1 }",
    "const options = { ...handlers, ...empty }",
    "Effect.tryPromise(options)"
  ].join("\n")),
  validCase([
    'import { Effect } from "effect"',
    "const Schema = { decodeUnknownSync: () => () => undefined }",
    "Effect.tryPromise({ try: () => host(), catch: (error) => Schema.decodeUnknownSync()(error) })"
  ].join("\n")),
  validCase('import { Effect, Schema } from "effect"\nEffect.sync(() => Schema.validateSync(Schema.String)(input))'),
  validCase([
    'import { Effect, Schema } from "effect"',
    "const decode = Schema.decodeUnknownSync(Schema.String)",
    "Effect.sync(() => Schema.encodeSync(Schema.String))",
    "Effect.sync(() => consume(decode))"
  ].join("\n")),
  validCase('import { Effect } from "effect"\nimport * as esbuild from "esbuild"\nEffect.tryPromise(() => esbuild.build({}))'),
  validCase([
    'import { Effect } from "effect"',
    'import { build } from "esbuild"',
    "const bundle = build",
    "Effect.tryPromise(() => bundle({}))"
  ].join("\n")),
  validCase([
    'import { Effect } from "effect"',
    'import { build } from "esbuild"',
    "declare const response: Response",
    "const api = { build }",
    "Effect.tryPromise(() => api.build({}))",
    "Effect.tryPromise(() => response.json())"
  ].join("\n")),
  validCase([
    'import { Effect, Layer, ManagedRuntime } from "effect"',
    "const runtime = ManagedRuntime.make(Layer.empty)",
    "Effect.tryPromise(() => runtime.dispose())",
    "Effect.tryPromise(() => runtime.context())",
    'Effect.tryPromise(() => import("./local-module.js"))'
  ].join("\n")),
  validCase("const Promise = class {}\nnew Promise()"),
  validCase([
    "const globalThis = {",
    "  Promise: class {},",
    "  fetch: () => undefined,",
    "  process: { env: { HOME: \"home\" } }",
    "}",
    "new globalThis.Promise()",
    "globalThis.fetch()",
    "globalThis.process.env.HOME"
  ].join("\n")),
  validCase([
    "const globalThis = { Promise: class {}, fetch: () => undefined, process: { env: {} } }",
    "const { Promise: NativePromise, fetch: hostFetch, process: hostProcess } = globalThis",
    "new NativePromise()",
    "hostFetch()",
    "hostProcess.env.HOME"
  ].join("\n")),
  validCase([
    "const global = { Promise: class {}, process: { env: {} } }",
    "const self = { fetch: () => undefined, performance: { now: () => 0 } }",
    "const window = { crypto: { randomUUID: () => \"local\" } }",
    "new global.Promise()",
    "global.process.env.HOME",
    "self.fetch()",
    "self.performance.now()",
    "window.crypto.randomUUID()"
  ].join("\n")),
  validCase([
    "const EffectPackage = { Effect: { runPromise: () => undefined, gen: () => undefined }, Schema: { encodeSync: () => undefined } }",
    "const { Effect: { gen: use = () => undefined, ...Fx }, Schema: { encodeSync: encode } } = EffectPackage",
    "const globalThis = { process: { env: { HOME: \"home\" } }, crypto: { subtle: { digest: () => undefined } }, fetch: () => undefined }",
    "const { process: { env: { HOME } }, crypto: { subtle: { digest } }, ...host } = globalThis",
    "use()",
    "Fx.runPromise()",
    "encode()",
    "HOME",
    "digest()",
    "host.fetch()"
  ].join("\n")),
  validCase([
    "const local = { runPromise: () => undefined, fs: { readFile: () => undefined } }",
    "const aggregate = { ...local, nested: { launch: local.runPromise } }",
    "aggregate.nested.launch(program)",
    "aggregate.fs.readFile(file)"
  ].join("\n")),
  validCase('export { Option } from "effect"'),
  validCase([
    'import { Effect } from "effect"',
    "const api = { succeed: Effect.succeed, value: Effect.succeed(1) }",
    "export default api",
    'export type * from "effect/Schema"'
  ].join("\n")),
  validCase([
    'import { Effect } from "effect"',
    "const local = { Effect: { succeed: (value) => value } }",
    "export const duplicate = { Effect, Effect: local.Effect }",
    "export const spread = { Effect, ...local }"
  ].join("\n")),
  validCase("type PromiseLike<Value> = { readonly value: Value }\ntype Result = PromiseLike<string>"),
  validCase("export const add = (left, right) => left + right"),
  validCase([
    'import { URL as NodeURL, URLSearchParams as NodeSearchParams } from "node:url"',
    'new NodeURL("/path", "https://example.test")',
    'new NodeSearchParams("key=value")',
    'NodeURL.canParse("/path", "https://example.test")',
    "consume(NodeURL.canParse)"
  ].join("\n")),
  validCase([
    'import { URL as NodeURL, type UrlObject } from "node:url"',
    'export { URLSearchParams, type URLFormatOptions } from "node:url"',
    'new NodeURL("/path", "https://example.test")'
  ].join("\n")),
  validCase([
    'const { URL: NodeURL, URLSearchParams: NodeSearchParams } = require("node:url")',
    'const { URL: OtherURL } = module.require("url")',
    'new NodeURL("/path", "https://example.test")',
    'new NodeSearchParams("key=value")',
    'OtherURL.canParse("/path", "https://example.test")'
  ].join("\n")),
  validCase([
    "const module = { require: () => ({ runPromise: () => undefined }) }",
    'const Fx = module.require("effect/Effect")',
    "Fx.runPromise(program)"
  ].join("\n")),
  validCase([
    'import type { Stats } from "node:fs"',
    'import { type Dirent, type PathLike } from "node:fs"',
    'import type FileSystem = require("node:fs")',
    'export type { Stats as FileStats } from "node:fs"',
    'export { type Dirent as FileEntry } from "node:fs"',
    'export type * from "electron/main"'
  ].join("\n")),
  validCase([
    'new URL("/path", "https://example.test")',
    'URL.canParse("/path", "https://example.test")',
    'new URLSearchParams("key=value").get("key")'
  ].join("\n")),
  validCase([
    "const first = import.meta.url",
    'const second = import.meta["url"]',
    "const size = first.length",
    'const local = second.startsWith("file:")'
  ].join("\n")),
  validCase("const first = import.meta[`url`]\nURL[`canParse`](first)"),
  validCase([
    "const URL = { createObjectURL: () => \"local\", revokeObjectURL: () => undefined }",
    "URL.createObjectURL(blob)",
    "URL.revokeObjectURL(value)"
  ].join("\n")),
  validCase('import { Option } from "effect"\nexport const load = () => Option.some(1)'),
  validCase("type Effect<Value> = { readonly value: Value }\nexport const load = (): Effect<number> => ({ value: 1 })"),
  validCase([
    "namespace Effect { export interface X<Value> { readonly value: Value } }",
    "export const load = (): Effect.X<number> => ({ value: 1 })"
  ].join("\n")),
  validCase([
    'import { Effect } from "effect"',
    "const load = () => 1",
    "function build() { const load = () => Effect.succeed(1); return load }",
    "export { load }"
  ].join("\n")),
  validCase([
    'import { Effect } from "effect"',
    "const traced = Effect.fn",
    "const operations = {",
    '  load: traced("load")(() => Effect.succeed(1)),',
    "  nested: { save: Effect.fnUntraced(() => Effect.succeed(2)) }",
    "}",
    "export const { load, nested: { save } } = operations"
  ].join("\n")),
  validCase([
    'import { Effect } from "effect"',
    "const operations: { load?: undefined } = {}",
    'export const { load = Effect.fn("load")(() => Effect.succeed(1)) } = operations'
  ].join("\n")),
  validCase([
    'import { Effect } from "effect"',
    "declare const operations: { load?: undefined }",
    "export const { load = Effect.fnUntraced(() => Effect.succeed(1)) } = operations"
  ].join("\n")),
  validCase([
    'import { Effect } from "effect"',
    "const operations = { nested: {} }",
    'export const { nested: { load = Effect.fn("load")(() => Effect.succeed(1)) } } = operations'
  ].join("\n")),
  validCase([
    'import { Effect } from "effect"',
    "declare const operations: { nested: { load?: undefined } }",
    "export const { nested: { load = Effect.fnUntraced(() => Effect.succeed(1)) } } = operations"
  ].join("\n")),
  validCase([
    'import { Schema } from "effect"',
    "consume(Schema[key])",
    "Schema[key](input)"
  ].join("\n")),
  validCase('import { Effect } from "effect"\nexport const values = [1].map(() => Effect.succeed(1))'),
  validCase([
    "const Effect = { runPromise: () => undefined, gen: (body) => body }",
    "const Schema = { decodeUnknownSync: () => () => undefined }",
    "const process = { env: { HOME: \"home\" } }",
    "const console = { log: () => undefined }",
    "const setTimeout = () => undefined",
    "const Date = class { static now() { return 0 } }",
    "const performance = { now: () => 0 }",
    "const Math = { random: () => 0 }",
    "const crypto = { randomUUID: () => \"id\" }",
    "const fetch = () => undefined",
    "const WebSocket = class {}",
    "const Worker = class {}",
    "const MessageChannel = class {}",
    "const window = { addEventListener: () => undefined }",
    "const document = { body: undefined }",
    "const navigator = { userAgent: \"test\" }",
    "const localStorage = { getItem: () => null }",
    "Effect.runPromise()",
    "Effect.gen(() => Schema.decodeUnknownSync()())",
    "process.env.HOME",
    "console.log()",
    "setTimeout()",
    "Date.now()",
    "performance.now()",
    "Math.random()",
    "crypto.randomUUID()",
    "fetch()",
    "new WebSocket()",
    "new Worker()",
    "new MessageChannel()",
    "window.addEventListener()",
    "document.body",
    "navigator.userAgent",
    "localStorage.getItem()"
  ].join("\n")),
  validCase([
    "const require = () => ({ Effect: { runPromise: () => undefined }, runFork: () => undefined })",
    'const { Effect: Fx } = require("effect")',
    'const LocalEffect = require("effect/Effect")',
    "Fx.runPromise(program)",
    "LocalEffect.runFork(program)"
  ].join("\n")),
  validCase([
    "const crypto = { subtle: { digest: () => undefined } }",
    "const performance = { mark: () => undefined }",
    "crypto.subtle.digest()",
    "performance.mark()"
  ].join("\n")),
  validCase([
    "class LocalResource { close() {} start() {} addEventListener() {} }",
    "const first = new LocalResource()",
    "const second = { close() {}, start() {}, addEventListener() {} }",
    "first.close()",
    "first.start()",
    'first.addEventListener("event", receive)',
    "second.close()",
    "second.start()",
    'second.addEventListener("event", receive)'
  ].join("\n")),
  validCase([
    "class LocalResource { close() {} start() {} subscribe() {} addEventListener() {} }",
    "const resource = new LocalResource()",
    "const base = { resource }",
    "const empty = { value: 1 }",
    "const state = { nested: { ...base, ...empty } }",
    "state.nested.resource.close()",
    "state.nested.resource.start()",
    "state.nested.resource.subscribe(receive)",
    'state.nested.resource.addEventListener("event", receive)'
  ].join("\n")),
  validCase([
    "class LocalResource { close() {} start() {} subscribe() {} }",
    "const state = { resource: new LocalResource() }",
    "const { resource } = state",
    "resource.close()",
    "resource.start()",
    "resource.subscribe(receive)"
  ].join("\n")),
  validCase([
    'import { Exit, PubSub, Scope } from "effect"',
    "declare const scope: Scope.Closeable",
    "declare const pubsub: PubSub.PubSub<string>",
    "Scope.close(scope, Exit.void)",
    "PubSub.subscribe(pubsub)"
  ].join("\n")),
  validCase([
    'import type { MainPortLike } from "./apps/desktop/src/main/rpc/server.js"',
    "declare const port: MainPortLike",
    "port.start()"
  ].join("\n")),
  validCase([
    "const Effect = { runForkWith: () => undefined, runPromiseWith: () => undefined }",
    "const Runtime = { makeRunMain: () => undefined }",
    "Effect.runForkWith()",
    "Effect.runPromiseWith()",
    "Runtime.makeRunMain()"
  ].join("\n")),
  validCase([
    "const Effect = { runPromise: () => undefined, runFork: () => undefined, runSync: () => undefined }",
    "const run = Effect.runPromise",
    "run.call(undefined, program)",
    "Effect.runFork.apply(undefined, [program])",
    "const bound = Effect.runSync.bind(undefined)",
    "bound(program)"
  ].join("\n")),
  validCase([
    "const local = { run: () => undefined, nested: { value: 1 } }",
    "local[key].call(local, value)",
    "consume(local[key].value)"
  ].join("\n")),
  withBoundaries(
    validCase('import { Effect } from "effect"\nEffect.runPromise(program)'),
    [runnerBoundary]
  ),
  withBoundaries(
    validCase([
      'import { Effect } from "effect"',
      "export const api = { first: Effect, second: Effect }"
    ].join("\n")),
    ["first", "second"].map((property) => ({
      file: "effect-boundary-valid.ts",
      declaration: `property:api.${property}`,
      host: `Test ${property} Effect capability export`,
      construct: "runner-re-export:namespace:Effect",
      occurrence: 0
    }))
  ),
  withBoundaries(
    validCase([
      'import { Effect } from "effect"',
      "Effect.runPromise(first)",
      "Effect.runPromise(second)"
    ].join("\n")),
    [runnerBoundary, { ...runnerBoundary, host: "Second test application entrypoint", occurrence: 1 }]
  ),
  withBoundaries(
    validCase([
      "function first() { const task = () => process.env.HOME; return task }",
      "function second() { const task = () => process.env.HOME; return task }"
    ].join("\n")),
    scopedProcessBoundaries
  ),
  withBoundaries(
    validCase([
      "const unrelated = 1",
      "function first() { const task = () => process.env.HOME; return task }",
      "function second() { const task = () => process.env.HOME; return task }"
    ].join("\n")),
    scopedProcessBoundaries
  ),
  withBoundaries(
    validCase([
      "items.map(() => { const task = () => process.env.HOME; return task })",
      "items.filter(() => { const task = () => process.env.HOME; return task })",
      "{ const task = () => process.env.HOME; consume(task) }",
      "{ const task = () => process.env.HOME; consume(task) }"
    ].join("\n")),
    anonymousAndBlockBoundaries
  ),
  withBoundaries(
    validCase([
      "const producer = () => { const task = () => process.env.HOME; return task }",
      "const handlers = { load: () => { const task = () => process.env.HOME; return task } }"
    ].join("\n")),
    ownedAnonymousBoundaries
  ),
  withBoundaries(
    validCase([
      "const unrelated = () => 0",
      "const other = { save: () => 0 }",
      "const producer = () => { const task = () => process.env.HOME; return task }",
      "const handlers = { unrelated: () => 0, load: () => { const task = () => process.env.HOME; return task } }"
    ].join("\n")),
    ownedAnonymousBoundaries
  ),
  withBoundaries(
    validCase([
      "const handlers = {",
      "  [`load`]: () => { const task = () => process.env.HOME; return task }",
      "}"
    ].join("\n")),
    [templatePropertyBoundary]
  ),
  withBoundaries(
    validCase([
      "const handlers = {",
      "  [`save`]: () => 0,",
      "  [`load`]: () => { const task = () => process.env.HOME; return task }",
      "}"
    ].join("\n")),
    [templatePropertyBoundary]
  ),
  withBoundaries(
    validCase([
      "class Handlers {",
      "  [`load`] = () => { const task = () => process.env.HOME; return task }",
      "}"
    ].join("\n")),
    [classFieldBoundary]
  ),
  withBoundaries(
    validCase([
      "class Handlers {",
      "  [`save`] = () => 0;",
      "  [`load`] = () => { const task = () => process.env.HOME; return task }",
      "}"
    ].join("\n")),
    [classFieldBoundary]
  ),
  withBoundaries(
    validCase([
      "items.forEach(() => 0)",
      "if (flag) { consume(flag) }",
      "items.map(() => { const task = () => process.env.HOME; return task })",
      "{ const task = () => process.env.HOME; consume(task) }",
      "items.filter(() => { const task = () => process.env.HOME; return task })",
      "{ const task = () => process.env.HOME; consume(task) }"
    ].join("\n")),
    anonymousAndBlockBoundaries
  ),
  withBoundaries(
    validCase([
      "items.map(() => { const task = () => process.env.HOME; return task })",
      "items.map(() => { const task = () => process.env.HOME; return task })"
    ].join("\n")),
    [0, 1].map((occurrence) => ({
      file: "effect-boundary-valid.ts",
      declaration: `scope:anonymous:call:member:identifier:items:map:argument:0:${occurrence}/variable:task`,
      host: `Equivalent map callback ${occurrence}`,
      construct: "platform:process.env.HOME",
      occurrence: 0
    }))
  ),
  withBoundaries(
    validCase([
      "other.map(() => 0)",
      "items.map(() => { const task = () => process.env.HOME; return task })",
      "items.filter(() => { const task = () => process.env.HOME; return task })",
      "{ const task = () => process.env.HOME; consume(task) }",
      "{ const task = () => process.env.HOME; consume(task) }"
    ].join("\n")),
    anonymousAndBlockBoundaries
  ),
  withBoundaries(
    validCase([
      "const unrelated = 1",
      "items.map(() => { const task = () => process.env.HOME; return task })",
      "{ const task = () => process.env.HOME; consume(task) }",
      "items.filter(() => { const task = () => process.env.HOME; return task })",
      "{ const task = () => process.env.HOME; consume(task) }"
    ].join("\n")),
    anonymousAndBlockBoundaries
  ),
  withBoundaries(
    validCase("interface Api { load(): Promise<string> }"),
    [{
      file: "effect-boundary-valid.ts",
      declaration: "interface:Api.load",
      host: "Test protocol signature",
      construct: "promise-type:Promise",
      occurrence: 0
    }]
  ),
  withBoundaries(
    validCase("type Results<T> = { [Key in keyof T]: PromiseLike<T[Key]> }"),
    [{
      file: "effect-boundary-valid.ts",
      declaration: "type:Results",
      host: "Test mapped signature",
      construct: "promise-type:PromiseLike",
      occurrence: 0
    }]
  ),
  withBoundaries(
    validCase([
      "interface AsyncValue<Value> { then(consume: (value: Value) => unknown): unknown }",
      "abstract class AbstractApi {",
      "  abstract value: AsyncValue<string>",
      "  abstract load(): AsyncValue<string>",
      "}"
    ].join("\n")),
    [
      {
        file: "effect-boundary-valid.ts",
        declaration: "member:AbstractApi.value",
        host: "Test abstract property signature",
        construct: "promise-like:value",
        occurrence: 0
      },
      {
        file: "effect-boundary-valid.ts",
        declaration: "member:AbstractApi.load",
        host: "Test abstract method signature",
        construct: "promise-like:return",
        occurrence: 0
      }
    ]
  ),
  {
    filename: absolute("effect-boundary-valid.mts"),
    code: [
      "const value = import.meta.url",
      "const size = value.length",
      'const local = import.meta[`url`].startsWith("file:")',
      "export { local, size, value }"
    ].join("\n"),
    languageOptions: {
      parserOptions: { project: false, projectService: false }
    }
  },
  {
    filename: absolute("effect-boundary-valid.cts"),
    code: 'const parsed = new URL("/path", "https://example.test")\nexport = parsed',
    languageOptions: {
      parserOptions: { project: false, projectService: false }
    }
  },
  {
    filename: absolute("effect-boundary-valid.mjs"),
    code: "const process = { env: {} }\nprocess.env.HOME",
    languageOptions: {
      parserOptions: { project: false, projectService: false }
    }
  },
  {
    filename: absolute("effect-boundary-valid.mjs"),
    code: 'import { Effect } from "effect"\nEffect.tryPromise(() => import("./local-module.js"))',
    languageOptions: {
      parserOptions: { project: false, projectService: false }
    }
  },
  {
    filename: absolute("effect-boundary-valid.mjs"),
    code: [
      "class LocalResource { close() {} start() {} addEventListener() {} }",
      "const resource = new LocalResource()",
      "const state = { resource }",
      "state.resource.close()",
      "state.resource.start()",
      'state.resource.addEventListener("event", receive)'
    ].join("\n"),
    languageOptions: {
      parserOptions: { project: false, projectService: false }
    }
  },
  {
    filename: absolute("effect-boundary-valid.mjs"),
    code: [
      "const Promise = { resolve: () => undefined, bind: () => function LocalPromise() {} }",
      "const URL = { createObjectURL: () => undefined }",
      "const fetch = () => undefined",
      "const WebSocket = function LocalSocket() {}",
      "const target = { addEventListener: () => undefined }",
      "const resource = { close: () => undefined }",
      "Promise.resolve.call(Promise, 1)",
      "Promise.bind(undefined)",
      "URL.createObjectURL.call(URL, blob)",
      "fetch.bind(undefined)(url)",
      "new (WebSocket.bind(undefined))(url)",
      'target.addEventListener.call(target, "event", receive)',
      "resource.close.bind(resource)()"
    ].join("\n"),
    languageOptions: {
      parserOptions: { project: false, projectService: false }
    }
  },
  {
    filename: absolute("effect-boundary-valid.cjs"),
    code: [
      "const local = { runPromise() {}, Schema: { decodeSync() {} } }",
      "const api = { nested: { ...local } }",
      "module.exports = api"
    ].join("\n"),
    languageOptions: {
      parserOptions: { project: false, projectService: false }
    }
  },
  {
    filename: absolute("effect-boundary-valid.mjs"),
    code: [
      'import { Effect } from "effect"',
      "const local = { Effect: { succeed: (value) => value } }",
      "export const duplicate = { Effect, Effect: local.Effect }",
      "export const spread = { Effect, ...local }"
    ].join("\n"),
    languageOptions: {
      parserOptions: { project: false, projectService: false }
    }
  },
  {
    filename: absolute("effect-boundary-valid.mjs"),
    code: [
      'import { Schema } from "effect"',
      "consume(Schema[key])",
      "Schema[key](input)"
    ].join("\n"),
    languageOptions: {
      parserOptions: { project: false, projectService: false }
    }
  },
  {
    filename: absolute("effect-boundary-valid.mjs"),
    code: [
      "class LocalResource { close() {} start() {} subscribe() {} }",
      "const state = { resource: new LocalResource() }",
      "const { resource } = state",
      "resource.close()",
      "resource.start()",
      "resource.subscribe(receive)"
    ].join("\n"),
    languageOptions: {
      parserOptions: { project: false, projectService: false }
    }
  }
]

const invalid = [
  invalidCase("async function load() {}", [{ messageId: "nativeAsync" }]),
  invalidCase("const load = async () => await host()", [{ messageId: "nativeAsync" }, { messageId: "nativeAwait" }]),
  invalidCase("new Promise(() => undefined)", [{ messageId: "nativePromise" }]),
  invalidCase([
    "new globalThis.Promise(() => undefined)",
    "globalThis.fetch(url)",
    "globalThis.process.env.HOME"
  ].join("\n"), [
    { messageId: "nativePromise" },
    { messageId: "platformEffect" },
    { messageId: "platformEffect" }
  ]),
  invalidCase([
    "new global.Promise(() => undefined)",
    "self.fetch(url)",
    "window.process.env.HOME",
    "self.performance.now()",
    "global.crypto.randomUUID()"
  ].join("\n"), [
    { messageId: "nativePromise" },
    ...Array.from({ length: 4 }, () => ({ messageId: "platformEffect" }))
  ]),
  invalidCase([
    "const { Promise: NativePromise, fetch: hostFetch, process: hostProcess } = self",
    "new NativePromise(() => undefined)",
    "hostFetch(url)",
    "hostProcess.env.HOME"
  ].join("\n"), [
    { messageId: "nativePromise" },
    { messageId: "platformEffect" },
    { messageId: "platformEffect" }
  ]),
  invalidCase([
    "const { Promise: NativePromise, fetch: hostFetch, process: hostProcess } = globalThis",
    "new NativePromise(() => undefined)",
    "hostFetch(url)",
    "hostProcess.env.HOME"
  ].join("\n"), [
    { messageId: "nativePromise" },
    { messageId: "platformEffect" },
    { messageId: "platformEffect" }
  ]),
  invalidCase("const NativePromise = Promise\nnew NativePromise(() => undefined)", [{ messageId: "nativePromise" }]),
  invalidCase("Promise.all([host()])\nPromise.resolve(1)", [{ messageId: "nativePromise" }, { messageId: "nativePromise" }]),
  invalidCase([
    'import { Effect } from "effect"',
    "Effect.tryPromise(() => ({",
    "  pending: new Promise((resolve) => resolve(1)),",
    "  queued: [Promise.resolve(2)]",
    "}))"
  ].join("\n"), [{ messageId: "nativePromise" }, { messageId: "nativePromise" }]),
  invalidCase([
    'import { Effect } from "effect"',
    "const array = () => [Promise.resolve(1)]",
    "const object = () => ({ pending: Promise.resolve(2) })",
    "const argument = () => consume(Promise.resolve(3))",
    "const unary = () => void Promise.resolve(4)",
    "const nonFinal = () => (Promise.resolve(5), value)",
    "Effect.tryPromise(array)",
    "Effect.tryPromise(object)",
    "Effect.tryPromise(argument)",
    "Effect.tryPromise(unary)",
    "Effect.tryPromise(nonFinal)"
  ].join("\n"), Array.from({ length: 5 }, () => ({ messageId: "nativePromise" }))),
  invalidCase([
    'import { Effect } from "effect"',
    "Effect.tryPromise({",
    "  try: () => Promise.resolve(1),",
    "  catch: () => new Promise((resolve) => resolve(\"failure\"))",
    "})"
  ].join("\n"), [
    { messageId: "promiseSignature", line: 4, column: 10 },
    { messageId: "nativePromise", line: 4, column: 16 }
  ]),
  invalidCase([
    'import { Effect, Schema } from "effect"',
    "Effect.tryPromise({",
    "  try: () => host(),",
    "  catch: (error) => Schema.decodeUnknownSync(Schema.String)(error)",
    "})"
  ].join("\n"), [{ messageId: "syncSchemaInEffect" }]),
  invalidCase([
    'import { Effect, Schema } from "effect"',
    "const produce = () => Promise.resolve(1)",
    "const recover = (error) => Schema.decodeUnknownSync(Schema.String)(error)",
    "const body = () => Schema.encodeSync(Schema.String)(input)",
    "const handlers = { try: produce, catch: recover, body }",
    "const empty = { value: 1 }",
    "const options = { ...handlers, ...empty }",
    "Effect.tryPromise(options)",
    "Effect.sync(handlers.body)"
  ].join("\n"), [
    { messageId: "syncSchemaInEffect", line: 3, column: 28 },
    { messageId: "syncSchemaInEffect", line: 4, column: 20 }
  ]),
  invalidCase([
    'import { Effect, Schema } from "effect"',
    "const producer = () => Promise.resolve(1)",
    "const recover = (error) => Schema.decodeUnknownSync(Schema.String)(error)",
    "const replacement = { try: () => host(), catch: identity }",
    "Effect.tryPromise({ try: producer, ...replacement })",
    "Effect.tryPromise({ try: producer, try: () => host() })",
    "Effect.tryPromise({ try: () => host(), catch: recover, ...replacement })"
  ].join("\n"), [
    { messageId: "promiseSignature", line: 2, column: 18 },
    { messageId: "nativePromise", line: 2, column: 24 }
  ]),
  invalidCase([
    'import { Effect, Schema } from "effect"',
    "const producer = () => Promise.resolve(1)",
    "const recover = (error) => Schema.decodeUnknownSync(Schema.String)(error)",
    "const matchRecover = (error) => Schema.decodeUnknownSync(Schema.String)(error)",
    "const { producer: tryFn, recover: body } = { producer, recover }",
    "Effect.tryPromise(tryFn)",
    "Effect.sync(body)",
    "const handlers = { onFailure: matchRecover, onSuccess: identity }",
    "Effect.match(program, handlers)"
  ].join("\n"), [
    { messageId: "syncSchemaInEffect", line: 3, column: 28 },
    { messageId: "syncSchemaInEffect", line: 4, column: 33 }
  ]),
  invalidCase([
    'import { Effect } from "effect"',
    "declare const unknown: Record<string, unknown>",
    "const produce = () => Promise.resolve(1)",
    "const options = { try: produce, ...unknown }",
    "Effect.tryPromise(options)"
  ].join("\n"), [
    { messageId: "promiseSignature" },
    { messageId: "nativePromise" }
  ]),
  invalidCase('import { Effect } from "effect"\nEffect.tryPromise(() => host().then(use))', [{ messageId: "promiseChain" }]),
  invalidCase([
    'import { Effect } from "effect"',
    "const producer = () => host().then(use)",
    "Effect.tryPromise(producer)"
  ].join("\n"), [{ messageId: "promiseChain" }]),
  invalidCase([
    'import { Effect } from "effect"',
    "Effect.tryPromise({ try: () => host().catch(recover).finally(cleanup), catch: identity })"
  ].join("\n"), [{ messageId: "promiseChain" }, { messageId: "promiseChain" }]),
  invalidCase("type Result = PromiseLike<string>", [{ messageId: "promiseSignature" }]),
  invalidCase("interface Api { load(): Promise<string> }", [{ messageId: "promiseSignature" }]),
  invalidCase("type Results<T> = { [Key in keyof T]: PromiseLike<T[Key]> }", [{ messageId: "promiseSignature" }]),
  invalidCase([
    "interface AsyncValue<Value> { then(consume: (value: Value) => unknown): unknown }",
    "interface Api { load(): AsyncValue<string> }"
  ].join("\n"), [{ messageId: "promiseSignature", line: 2, column: 17 }]),
  invalidCase([
    "interface AsyncValue<Value> { then(consume: (value: Value) => unknown): unknown }",
    "declare function overloaded(flag: false): number",
    "declare function overloaded(flag: true): AsyncValue<number>",
    "overloaded(false)",
    "overloaded(true)"
  ].join("\n"), [
    { messageId: "promiseSignature", line: 3, column: 1 },
    { messageId: "promiseSignature", line: 5, column: 1 }
  ]),
  invalidCase([
    "interface AsyncValue<Value> { then(use: (value: Value) => unknown): unknown }",
    "declare const pending: AsyncValue<number>",
    "function overloaded(flag: false): number",
    "function overloaded(flag: true): AsyncValue<number>",
    "function overloaded(flag: boolean): number | AsyncValue<number> { return flag ? pending : 1 }",
    "overloaded(false)",
    "overloaded(true)"
  ].join("\n"), [
    { messageId: "promiseSignature", line: 4, column: 1 },
    { messageId: "promiseSignature", line: 7, column: 1 }
  ]),
  invalidCase([
    "interface AsyncValue<Value> { then(use: (value: Value) => unknown): unknown }",
    "interface Factory {",
    "  new (flag: false): { value: number }",
    "  new (flag: true): AsyncValue<number>",
    "}",
    "declare const Factory: Factory",
    "new Factory(false)",
    "new Factory(true)"
  ].join("\n"), [
    { messageId: "promiseSignature", line: 4, column: 3 },
    { messageId: "promiseSignature", line: 8, column: 1 }
  ]),
  invalidCase([
    "interface AsyncValue<Value> { then(consume: (value: Value) => unknown): unknown }",
    "type Results<Input> = { [Key in keyof Input]: () => AsyncValue<Input[Key]> }"
  ].join("\n"), [{ messageId: "promiseSignature", line: 2, column: 47 }]),
  invalidCase([
    "interface AsyncValue<Value> { then(consume: (value: Value) => unknown): unknown }",
    "interface Api { load: AsyncValue<string> }"
  ].join("\n"), [{ messageId: "promiseSignature", line: 2, column: 17 }]),
  invalidCase([
    "interface AsyncValue<Value> { then(consume: (value: Value) => unknown): unknown }",
    "type Results<Input> = { [Key in keyof Input]: AsyncValue<Input[Key]> }"
  ].join("\n"), [{ messageId: "promiseSignature", line: 2, column: 47 }]),
  invalidCase([
    "interface AsyncValue<Value> { then(consume: (value: Value) => unknown): unknown }",
    "declare const host: AsyncValue<string>",
    "class Fields { explicit!: AsyncValue<string>; inferred = host }",
    "interface Index { [key: string]: AsyncValue<string> }",
    "type Factory = new () => AsyncValue<string>",
    "abstract class AbstractApi { abstract value: AsyncValue<string>; abstract load(): AsyncValue<string> }",
    "declare class DeclaredApi { load(): AsyncValue<string> }"
  ].join("\n"), Array.from({ length: 7 }, () => ({ messageId: "promiseSignature" }))),
  invalidCase([
    "interface AsyncValue<Value> { then(consume: (value: Value) => unknown): unknown }",
    "declare const host: AsyncValue<string>",
    "class Api { accessor value: AsyncValue<string> = host }",
    "type Alias = AsyncValue<string>",
    "type Handler = (input: Promise<string>) => AsyncValue<string>"
  ].join("\n"), Array.from({ length: 4 }, () => ({ messageId: "promiseSignature" }))),
  invalidCase("declare const host: { then(consume: (value: string) => unknown): unknown }\nconst load = () => host", [{ messageId: "promiseSignature" }]),
  invalidCase([
    'import * as esbuild from "esbuild"',
    "esbuild.build({})",
    "const pending = esbuild.build({})",
    "const bundle = esbuild.build",
    "bundle({})"
  ].join("\n"), Array.from({ length: 3 }, () => ({ messageId: "promiseSignature" }))),
  invalidCase([
    'import { Layer, ManagedRuntime } from "effect"',
    "const runtime = ManagedRuntime.make(Layer.empty)",
    "runtime.dispose()",
    "runtime.context()"
  ].join("\n"), Array.from({ length: 2 }, () => ({ messageId: "promiseSignature" }))),
  invalidCase([
    'import { build } from "esbuild"',
    'import { Layer, ManagedRuntime } from "effect"',
    "declare const response: Response",
    "const api = { build }",
    "const runtime = ManagedRuntime.make(Layer.empty)",
    "const state = { nested: { runtime } }",
    "api.build({})",
    "state.nested.runtime.dispose()",
    "state.nested.runtime.context()",
    "response.json()"
  ].join("\n"), Array.from({ length: 4 }, () => ({ messageId: "promiseSignature" }))),
  invalidCase('import * as esbuild from "esbuild"\nconst load = () => esbuild.build({})', [{ messageId: "promiseSignature" }]),
  invalidCase('import("./local-module.js")', [{ messageId: "promiseSignature" }]),
  invalidCase([
    'import * as EffectPackage from "effect"',
    "const { Effect: { runPromise: run = fallback, fn, ...Fx }, Schema: { encodeSync: encode } } = EffectPackage",
    "run(program)",
    "Fx.runFork(program)",
    "EffectPackage.Effect.sync(() => encode(EffectPackage.Schema.String)(input))"
  ].join("\n"), [
    { messageId: "runnerOutsideBoundary" },
    { messageId: "runnerOutsideBoundary" },
    { messageId: "syncSchemaInEffect" }
  ]),
  invalidCase([
    'import { Effect, Layer, ManagedRuntime } from "effect"',
    "const methods = { launch: Effect.runPromise }",
    "const api = { ...methods }",
    "const runtime = ManagedRuntime.make(Layer.empty)",
    "const state = { nested: { runtime } }",
    "api.launch(program)",
    "state.nested.runtime.runPromise(program)"
  ].join("\n"), Array.from({ length: 3 }, () => ({ messageId: "runnerOutsideBoundary" }))),
  invalidCase([
    'import { Effect } from "effect"',
    'import fs from "node:fs"',
    "const runners = { launch: Effect.runPromise }",
    "const platform = { fs }",
    "const empty = { value: 1 }",
    "const api = { ...runners, ...empty }",
    "const host = { ...platform, ...empty }",
    "api.launch(program)",
    "host.fs.readFile(file, receive)"
  ].join("\n"), [
    { messageId: "platformEffect" },
    { messageId: "runnerOutsideBoundary" },
    { messageId: "platformEffect" },
    { messageId: "runnerOutsideBoundary" },
    { messageId: "platformEffect" }
  ]),
  invalidCase([
    'import * as Platform from "@effect/platform-node"',
    "const { NodeRuntime: { runMain: launch = fallback } } = Platform",
    "launch(program)"
  ].join("\n"), [{ messageId: "runnerOutsideBoundary" }]),
  invalidCase([
    "const { process: { env: { HOME } }, crypto: { subtle: { digest } }, ...host } = globalThis",
    "HOME",
    'digest("SHA-256", data)',
    "host.fetch(url)"
  ].join("\n"), Array.from({ length: 3 }, () => ({ messageId: "platformEffect" }))),
  invalidCase("host().then(use)", [{ messageId: "promiseChain" }]),
  invalidCase("host().catch(recover).finally(cleanup)", [{ messageId: "promiseChain" }, { messageId: "promiseChain" }]),
  invalidCase("const value = process.env.HOME", [{ messageId: "platformEffect" }]),
  invalidCase('import { readFile as read } from "node:fs/promises"\nread(file)', [
    { messageId: "platformEffect" },
    { messageId: "platformEffect" }
  ]),
  invalidCase('import { URL, fileURLToPath } from "node:url"\nfileURLToPath(URL)', [
    { messageId: "platformEffect" },
    { messageId: "platformEffect" }
  ]),
  invalidCase([
    "URL.createObjectURL(blob)",
    "URL.revokeObjectURL(value)"
  ].join("\n"), Array.from({ length: 2 }, () => ({ messageId: "platformEffect" }))),
  invalidCase([
    'import { Effect, Schema } from "effect"',
    "Effect[`runPromise`](program)",
    "Effect.sync(() => Schema[`decodeUnknownSync`](Schema.String)(input))",
    "Promise[`resolve`](1)",
    "import.meta[`env`]",
    'const runner = "runFork"',
    "Effect[runner](program)",
    'const property = "dirname"',
    "import.meta[property]"
  ].join("\n"), [
    { messageId: "runnerOutsideBoundary" },
    { messageId: "syncSchemaInEffect" },
    { messageId: "nativePromise" },
    { messageId: "platformEffect" },
    { messageId: "runnerOutsideBoundary" },
    { messageId: "platformEffect" }
  ]),
  invalidCase([
    'import { Effect, Schema } from "effect"',
    "Effect[key].call(undefined, program)",
    "Effect.sync(() => Schema[key].call(Schema, Schema.String)(input))",
    "Promise[key].call(Promise, value)",
    "URL[key].call(URL, value)",
    "consume(import.meta[key].value)"
  ].join("\n"), [
    { messageId: "runnerOutsideBoundary" },
    { messageId: "syncSchemaInEffect" },
    { messageId: "nativePromise" },
    { messageId: "platformEffect" },
    { messageId: "platformEffect" }
  ]),
  invalidCase([
    'import { Effect, Schema } from "effect"',
    "Effect.runPromise[key].call(undefined, program)",
    "Effect.sync(() => Schema.decodeUnknownSync[key].call(Schema, Schema.String)(input))",
    "Promise.resolve[key].call(Promise, value)"
  ].join("\n"), [
    { messageId: "runnerOutsideBoundary" },
    { messageId: "syncSchemaInEffect" },
    { messageId: "nativePromise" }
  ]),
  invalidCase([
    'import { Effect, Schema } from "effect"',
    "Effect.sync(() => Schema.decodeUnknownSync.call(Schema, Schema.String)(input))"
  ].join("\n"), [{ messageId: "syncSchemaInEffect" }]),
  invalidCase([
    'import { Effect, Schema } from "effect"',
    "const { [`runPromise`]: launch } = Effect",
    "const { [`decodeUnknownSync`]: decode } = Schema",
    "launch(program)",
    "Effect.sync(() => decode(Schema.String)(input))",
    'const method = "runFork"',
    "const { [method]: dynamicRun } = Effect",
    "dynamicRun(program)"
  ].join("\n"), [
    { messageId: "runnerOutsideBoundary" },
    { messageId: "syncSchemaInEffect" },
    { messageId: "runnerOutsideBoundary" }
  ]),
  invalidCase([
    "import.meta.env",
    "import.meta.dirname",
    "import.meta.filename",
    "import.meta.main",
    'import.meta.resolve("./module.js")',
    "const { env } = import.meta",
    "consume(import.meta)"
  ].join("\n"), Array.from({ length: 7 }, () => ({ messageId: "platformEffect" }))),
  invalidCase([
    'const url = "url"',
    "import.meta[url]",
    "import.meta[getKey()]",
    'import.meta["u" + "rl"]'
  ].join("\n"), Array.from({ length: 3 }, () => ({ messageId: "platformEffect" }))),
  invalidCase([
    'import { URL as NodeURL } from "node:url"',
    "NodeURL.createObjectURL(blob)",
    "NodeURL.revokeObjectURL(value)"
  ].join("\n"), Array.from({ length: 2 }, () => ({ messageId: "platformEffect" }))),
  invalidCase([
    'import { URL as NodeURL } from "node:url"',
    "consume(NodeURL.createObjectURL)",
    "consume(NodeURL.revokeObjectURL)",
    "NodeURL.createObjectURL.call(NodeURL, blob)",
    "NodeURL.revokeObjectURL.apply(NodeURL, [value])"
  ].join("\n"), Array.from({ length: 4 }, () => ({ messageId: "platformEffect" }))),
  invalidCase([
    'import { URL as NodeURL } from "node:url"',
    "const { createObjectURL, revokeObjectURL: revoke } = NodeURL",
    "consume(createObjectURL)",
    "consume(revoke)"
  ].join("\n"), Array.from({ length: 2 }, () => ({ messageId: "platformEffect" }))),
  invalidCase([
    "console.log(value)",
    "setTimeout(task, 1)",
    "queueMicrotask(task)",
    "Date.now()",
    "performance.now()",
    "Math.random()",
    "crypto.randomUUID()",
    "fetch(url)",
    "new WebSocket(url)",
    "new Worker(url)",
    "new MessageChannel()",
    "target.addEventListener(\"message\", receive)",
    "document.body",
    "window.location",
    "navigator.userAgent",
    "localStorage.getItem(\"key\")",
    "indexedDB.open(\"database\")"
  ].join("\n"), Array.from({ length: 17 }, () => ({ messageId: "platformEffect" }))),
  invalidCase([
    'target.addEventListener("event", receive)',
    "resource.close()",
    "port.start()"
  ].join("\n"), Array.from({ length: 3 }, () => ({ messageId: "platformEffect" }))),
  invalidCase([
    "declare const state: unknown",
    'state["resource"].close()',
    "state.resource.start()",
    "state.resource.subscribe(receive)",
    'state.resource.addEventListener("event", receive)'
  ].join("\n"), Array.from({ length: 4 }, () => ({ messageId: "platformEffect" }))),
  invalidCase([
    "class LocalResource { close() {} start() {} subscribe() {} }",
    "const known = { resource: new LocalResource() }",
    "declare const unknown: { resource?: LocalResource }",
    "const { resource } = { ...known, ...unknown }",
    "resource.close()",
    "resource.start()",
    "resource.subscribe(receive)"
  ].join("\n"), Array.from({ length: 3 }, () => ({ messageId: "platformEffect" }))),
  invalidCase([
    "declare const element: HTMLElement",
    "declare const messagePort: MessagePort",
    'element.addEventListener("event", receive)',
    "messagePort.start()",
    "messagePort.close()"
  ].join("\n"), Array.from({ length: 3 }, () => ({ messageId: "platformEffect" }))),
  invalidCase([
    'import WebSocket from "ws"',
    'const socket = new WebSocket("ws://example.test")',
    "socket.close()"
  ].join("\n"), Array.from({ length: 3 }, () => ({ messageId: "platformEffect" }))),
  invalidCase([
    'crypto.subtle.digest("SHA-256", data)',
    'performance.mark("start")'
  ].join("\n"), [
    { messageId: "platformEffect" },
    { messageId: "platformEffect" }
  ]),
  invalidCase('import { Effect } from "effect"\nEffect.runPromise(program)', [{ messageId: "runnerOutsideBoundary" }]),
  invalidCase('import { Effect as Fx } from "effect"\nconst { runPromise: run } = Fx\nrun(program)', [{ messageId: "runnerOutsideBoundary" }]),
  invalidCase('import { runPromise as run } from "effect/Effect"\nrun(program)', [{ messageId: "runnerOutsideBoundary" }]),
  invalidCase('import * as EffectPackage from "effect"\nEffectPackage.Effect.runPromise(program)', [{ messageId: "runnerOutsideBoundary" }]),
  invalidCase('import * as EffectPackage from "effect"\nconst { Effect: Fx } = EffectPackage\nFx.runPromise(program)', [{ messageId: "runnerOutsideBoundary" }]),
  invalidCase('import { Runtime as EffectRuntime } from "effect"\nEffectRuntime.makeRunMain(host)', [{ messageId: "runnerOutsideBoundary" }]),
  invalidCase([
    'import { Effect } from "effect"',
    'import { runPromiseWith as runWith } from "effect/Effect"',
    "Effect.runForkWith(context)(program)",
    "Effect.runCallbackWith(context)(program)",
    "runWith(context)(program)",
    "Effect.runPromiseExitWith(context)(program)",
    "Effect.runSyncWith(context)(program)",
    "Effect.runSyncExitWith(context)(program)"
  ].join("\n"), Array.from({ length: 6 }, () => ({ messageId: "runnerOutsideBoundary" }))),
  invalidCase([
    'import { Effect } from "effect"',
    "const run = Effect.runPromise",
    "run.call(undefined, program)",
    "Effect.runFork.apply(undefined, [program])",
    "const bound = Effect.runSync.bind(undefined)",
    "bound(program)"
  ].join("\n"), Array.from({ length: 3 }, () => ({ messageId: "runnerOutsideBoundary" }))),
  invalidCase('import { NodeRuntime as Runtime } from "@effect/platform-node"\nRuntime.runMain(program)', [{ messageId: "runnerOutsideBoundary" }]),
  invalidCase('import { NodeRuntime as Runtime } from "@effect/platform-node"\nprogram.pipe(Runtime.runMain)', [{ messageId: "runnerOutsideBoundary" }]),
  invalidCase('import * as Platform from "@effect/platform-node"\nPlatform.NodeRuntime.runMain(program)', [{ messageId: "runnerOutsideBoundary" }]),
  invalidCase([
    'const { Effect: { runPromise: run } } = require("effect")',
    'const Fx = require("effect/Effect")',
    "const { runFork } = Fx",
    'const { NodeRuntime } = require("@effect/platform-node")',
    'const DirectRuntime = require("@effect/platform-node/NodeRuntime")',
    "run(program)",
    "runFork(program)",
    "NodeRuntime.runMain(program)",
    "DirectRuntime.runMain(program)"
  ].join("\n"), Array.from({ length: 4 }, () => ({ messageId: "runnerOutsideBoundary" }))),
  invalidCase([
    'import Fx = require("effect/Effect")',
    'import Runtime = require("@effect/platform-node/NodeRuntime")',
    "Fx.runPromise(program)",
    "Runtime.runMain(program)"
  ].join("\n"), Array.from({ length: 2 }, () => ({ messageId: "runnerOutsideBoundary" }))),
  invalidCase([
    'import FileSystem = require("node:fs")',
    'import Electron = require("electron")'
  ].join("\n"), Array.from({ length: 2 }, () => ({ messageId: "platformEffect" }))),
  invalidCase([
    'export { readFile } from "node:fs/promises"',
    'export * as ElectronMain from "electron/main"'
  ].join("\n"), Array.from({ length: 2 }, () => ({ messageId: "platformEffect" }))),
  invalidCase([
    'import { type Stats, readFile } from "node:fs"',
    'export { type Dirent, writeFile } from "node:fs"'
  ].join("\n"), Array.from({ length: 2 }, () => ({ messageId: "platformEffect" }))),
  invalidCase([
    'export { runPromise as launch } from "effect/Effect"',
    'export { runMain } from "@effect/platform-node/NodeRuntime"',
    'export * from "effect/Effect"'
  ].join("\n"), Array.from({ length: 3 }, () => ({ messageId: "runnerOutsideBoundary" }))),
  invalidCase([
    'export { Effect, Runtime, ManagedRuntime } from "effect"',
    'export { NodeRuntime } from "@effect/platform-node"',
    'export * as Fx from "effect/Effect"'
  ].join("\n"), Array.from({ length: 5 }, () => ({ messageId: "runnerOutsideBoundary" }))),
  invalidCase([
    'export { Schema } from "effect"',
    'export { decodeSync, encodeUnknownSync } from "effect/Schema"',
    'export * from "effect/Schema"'
  ].join("\n"), Array.from({ length: 4 }, () => ({ messageId: "syncSchemaInEffect" }))),
  invalidCase([
    'import { Effect, Schema } from "effect"',
    "const capabilities = { Effect, decode: Schema.decodeUnknownSync }",
    "export const api = { nested: { ...capabilities } }",
    "export default { Schema }"
  ].join("\n"), [
    { messageId: "runnerOutsideBoundary" },
    { messageId: "syncSchemaInEffect" },
    { messageId: "syncSchemaInEffect" }
  ]),
  invalidCase([
    'import { Effect, Schema } from "effect"',
    "export const tuple = [Effect, Schema]",
    "declare const unknown: Record<string, unknown>",
    "export const conservative = { Effect, ...unknown }"
  ].join("\n"), [
    { messageId: "runnerOutsideBoundary", line: 2, column: 23 },
    { messageId: "syncSchemaInEffect", line: 2, column: 31 },
    { messageId: "runnerOutsideBoundary", line: 4, column: 31 }
  ]),
  invalidCase([
    'import { Effect, Schema } from "effect"',
    "const api = { Effect, Schema }",
    "export { api }",
    "export default api"
  ].join("\n"), [
    { messageId: "runnerOutsideBoundary", line: 3, column: 10 },
    { messageId: "syncSchemaInEffect", line: 3, column: 10 },
    { messageId: "runnerOutsideBoundary", line: 4, column: 16 },
    { messageId: "syncSchemaInEffect", line: 4, column: 16 }
  ]),
  invalidCase([
    'import { Effect, Runtime } from "effect"',
    "const launch = Effect.runPromise",
    "const { runFork } = Effect",
    "export { Effect, launch, runFork }",
    "export default Runtime",
    "export const direct = Effect.runSync",
    "export const { runCallback } = Effect"
  ].join("\n"), Array.from({ length: 6 }, () => ({ messageId: "runnerOutsideBoundary" }))),
  invalidCase([
    'module.exports = require("effect/Effect")',
    'const Runtime = require("@effect/platform-node/NodeRuntime")',
    "exports.Runtime = Runtime"
  ].join("\n"), Array.from({ length: 2 }, () => ({ messageId: "runnerOutsideBoundary" }))),
  invalidCase([
    'module.exports[key] = require("effect/Effect")',
    'exports[key] = require("effect/Schema")'
  ].join("\n"), [
    { messageId: "runnerOutsideBoundary" },
    { messageId: "syncSchemaInEffect" }
  ]),
  withBoundaries(
    invalidCase([
      'import fs from "node:fs"',
      "const platform = fs",
      "const { readFile } = fs",
      "export { fs, platform, readFile }",
      "export const direct = fs"
    ].join("\n"), Array.from({ length: 4 }, () => ({ messageId: "platformEffect" }))),
    [{
      file: "effect-boundary-invalid.ts",
      declaration: "module:<module>",
      host: "Test node filesystem import",
      construct: "platform:import:node:fs",
      occurrence: 0
    }]
  ),
  invalidCase([
    'import(`node:fs`)',
    'require(`electron/main`)',
    'const Fx = require(`effect/Effect`)',
    "Fx.runPromise(program)"
  ].join("\n"), [
    { messageId: "platformEffect" },
    { messageId: "platformEffect" },
    { messageId: "runnerOutsideBoundary" }
  ]),
  invalidCase([
    'module.require("node:fs")',
    'const Fx = module.require("effect/Effect")',
    "Fx.runFork(program)"
  ].join("\n"), [
    { messageId: "platformEffect" },
    { messageId: "runnerOutsideBoundary" }
  ]),
  invalidCase([
    'const NodeUrl = require("node:url")',
    'const { URL, fileURLToPath } = require("node:url")'
  ].join("\n"), Array.from({ length: 2 }, () => ({ messageId: "platformEffect" }))),
  invalidCase('import { ManagedRuntime as Runtime } from "effect"\nconst runtime = Runtime.make(layer)\nruntime.runPromise(program)', [{ messageId: "runnerOutsideBoundary" }]),
  invalidCase('import { Effect } from "effect"\nexport const load = () => Effect.succeed(1)', [{ messageId: "effectFunctionBoundary" }]),
  invalidCase('import { Effect } from "effect"\nexport function load() { return Effect.succeed(1) }', [{ messageId: "effectFunctionBoundary" }]),
  invalidCase('import { Effect } from "effect"\nfunction load() { return Effect.succeed(1) }\nexport { load }', [{ messageId: "effectFunctionBoundary" }]),
  invalidCase('import { Effect } from "effect"\nfunction load() { return Effect.succeed(1) }\nexport default load', [{ messageId: "effectFunctionBoundary" }]),
  invalidCase('import { Effect } from "effect"\nconst load = () => Effect.succeed(1)\nexport { load }', [{ messageId: "effectFunctionBoundary" }]),
  invalidCase([
    'import { Effect } from "effect"',
    "const operations = { load: () => Effect.succeed(1), nested: { save: () => Effect.succeed(2) } }",
    "export const { load, nested: { save } } = operations"
  ].join("\n"), [
    { messageId: "effectFunctionBoundary" },
    { messageId: "effectFunctionBoundary" }
  ]),
  invalidCase([
    'import { Effect } from "effect"',
    "declare const operations: { load?: () => Effect.Effect<number> }",
    'export const { load = Effect.fn("load")(() => Effect.succeed(1)) } = operations'
  ].join("\n"), [{ messageId: "effectFunctionBoundary" }]),
  invalidCase([
    'import { Effect } from "effect"',
    "declare const unknown: { load?: () => Effect.Effect<number> }",
    "const operations = { nested: unknown }",
    'export const { nested: { load = Effect.fn("load")(() => Effect.succeed(1)) } } = operations'
  ].join("\n"), [{ messageId: "effectFunctionBoundary" }]),
  invalidCase([
    'import { Effect } from "effect"',
    "const operations = { load: () => Effect.succeed(1) }",
    "export const { load = Effect.fnUntraced(() => Effect.succeed(2)) } = operations"
  ].join("\n"), [{ messageId: "effectFunctionBoundary" }]),
  invalidCase([
    'import { Effect } from "effect"',
    "const operations = { load: () => Effect.succeed(1) }",
    "const { load } = operations",
    "export { load }"
  ].join("\n"), [{ messageId: "effectFunctionBoundary" }]),
  invalidCase([
    'import { Effect } from "effect"',
    "export const load = () => {",
    '  const wrapped = Effect.fn("wrapped")(() => Effect.succeed(1))',
    "  return Effect.succeed(wrapped)",
    "}"
  ].join("\n"), [{ messageId: "effectFunctionBoundary" }]),
  invalidCase('import { Effect, Schema } from "effect"\nEffect.gen(function*() { return Schema.decodeUnknownSync(Schema.String)(input) })', [{ messageId: "syncSchemaInEffect" }]),
  invalidCase('import { Effect as Fx, Schema as S } from "effect"\nconst { decodeSync: decode } = S\nFx.sync(() => decode(S.String)(input))', [{ messageId: "syncSchemaInEffect" }]),
  invalidCase([
    'import { Effect, Schema } from "effect"',
    'import { encodeUnknownSync as encodeDirect } from "effect/Schema"',
    "const { encodeUnknownSync: encodeAlias } = Schema",
    "Effect.gen(function*() { return Schema.encodeUnknownSync(Schema.String)(input) })",
    "Effect.sync(() => encodeDirect(Schema.String)(input))",
    "Effect.map(program, () => encodeAlias(Schema.String)(input))",
    "Effect.tryPromise({ try: () => host(), catch: (error) => Schema.encodeUnknownSync(Schema.String)(error) })"
  ].join("\n"), Array.from({ length: 4 }, () => ({ messageId: "syncSchemaInEffect" }))),
  invalidCase([
    'import { Effect, Schema } from "effect"',
    "const decode = Schema.decodeSync(Schema.String)",
    "const decodeUnknown = Schema.decodeUnknownSync(Schema.String)",
    "const codecs = { encode: Schema.encodeSync(Schema.String) }",
    "const encodeUnknown = Schema.encodeUnknownSync(Schema.String)",
    "function body() { return decode(input) }",
    "const mapped = () => decodeUnknown(input)",
    "const recover = (error) => encodeUnknown(error)",
    "Effect.sync(body)",
    "Effect.map(program, mapped)",
    "Effect.gen(function*() { return codecs.encode(input) })",
    "Effect.tryPromise({ try: () => host(), catch: recover })"
  ].join("\n"), Array.from({ length: 4 }, () => ({ messageId: "syncSchemaInEffect" }))),
  withBoundaries(
    invalidCase('import { Effect } from "effect"\nEffect.runPromise(first)\nEffect.runPromise(second)', [{ messageId: "runnerOutsideBoundary" }]),
    [{ ...runnerBoundary, file: "effect-boundary-invalid.ts" }]
  ),
  withBoundaries(
    invalidCase([
      'import defaultFs from "node:fs"',
      'import * as promiseFs from "node:fs/promises"',
      'import { readFile as read } from "node:fs/promises"',
      "const alias = read",
      "const { stat: inspect } = defaultFs",
      "read(file)",
      "promiseFs.readFile(file)",
      "alias(file)",
      "inspect(file)",
      "consume(defaultFs)",
      "consume(read)"
    ].join("\n"), Array.from({ length: 6 }, () => ({ messageId: "platformEffect" }))),
    [
      {
        file: "effect-boundary-invalid.ts",
        declaration: "module:<module>",
        host: "Test node filesystem import",
        construct: "platform:import:node:fs",
        occurrence: 0
      },
      ...[0, 1].map((occurrence) => ({
        file: "effect-boundary-invalid.ts",
        declaration: "module:<module>",
        host: `Test node promises import ${occurrence}`,
        construct: "platform:import:node:fs/promises",
        occurrence
      }))
    ]
  ),
  withBoundaries(
    invalidCase('import { BrowserWindow as Window } from "electron"\nnew Window(options)', [
      { messageId: "platformEffect" }
    ]),
    [{
      file: "effect-boundary-invalid.ts",
      declaration: "module:<module>",
      host: "Test Electron import",
      construct: "platform:import:electron",
      occurrence: 0
    }]
  ),
  withBoundaries(
    invalidCase("export const value = 1", [{ messageId: "staleBoundary" }]),
    [{ ...runnerBoundary, file: "effect-boundary-invalid.ts" }]
  ),
  withBoundaries(
    invalidCase("export const value = 1", [{ messageId: "staleBoundary" }]),
    [{ ...runnerBoundary, file: "effect-boundary-invalid.ts", declaration: "" }]
  ),
  withBoundaries(
    invalidCase("export const value = 1", [{ messageId: "staleBoundary" }]),
    [{ ...runnerBoundary, file: "apps/**" }]
  ),
  withBoundaries(
    invalidCase('import { Effect } from "effect"\nEffect.runPromise(program)', [
      { messageId: "staleBoundary" },
      { messageId: "runnerOutsideBoundary" }
    ]),
    [{ ...runnerBoundary, file: "effect-boundary-invalid.ts", host: "Test * entrypoint" }]
  ),
  withBoundaries(
    invalidCase("export const value = 1", [
      { messageId: "staleBoundary" },
      { messageId: "staleBoundary" }
    ]),
    [
      { ...runnerBoundary, file: "effect-boundary-invalid.ts" },
      { ...runnerBoundary, file: "effect-boundary-invalid.ts" }
    ]
  ),
  withBoundaries(
    invalidCase("export const value = 1", [{ messageId: "staleBoundary" }]),
    [{ ...runnerBoundary, file: "test/eslint/" }]
  ),
  invalidCase('require("node:fs")', [{ messageId: "platformEffect" }]),
  invalidCase("consume(document)\nDate()\nport.postMessage(value)", [
    { messageId: "platformEffect" },
    { messageId: "platformEffect" },
    { messageId: "platformEffect" }
  ]),
  {
    filename: absolute("effect-boundary-invalid.mjs"),
    code: "async function load() {}\nprocess.env.HOME",
    errors: [{ messageId: "nativeAsync" }, { messageId: "platformEffect" }],
    languageOptions: {
      parserOptions: { project: false, projectService: false }
    }
  },
  {
    filename: absolute("effect-boundary-invalid.mjs"),
    code: [
      "state.resource.close()",
      "state.resource.start()",
      "state.resource.subscribe(receive)",
      'state.resource.addEventListener("event", receive)'
    ].join("\n"),
    errors: Array.from({ length: 4 }, () => ({ messageId: "platformEffect" })),
    languageOptions: {
      parserOptions: { project: false, projectService: false }
    }
  },
  {
    filename: absolute("effect-boundary-invalid.mjs"),
    code: [
      "class LocalResource { close() {} start() {} subscribe() {} }",
      "const known = { resource: new LocalResource() }",
      "const unknown = source()",
      "const { resource } = { ...known, ...unknown }",
      "resource.close()",
      "resource.start()",
      "resource.subscribe(receive)"
    ].join("\n"),
    errors: Array.from({ length: 3 }, () => ({ messageId: "platformEffect" })),
    languageOptions: {
      parserOptions: { project: false, projectService: false }
    }
  },
  {
    filename: absolute("effect-boundary-invalid.mjs"),
    code: [
      'import { Effect, Schema } from "effect"',
      "Effect[key].call(undefined, program)",
      "Effect.sync(() => Schema[key].call(Schema, Schema.String)(input))",
      "Promise[key].call(Promise, value)",
      "URL[key].call(URL, value)",
      "consume(import.meta[key].value)"
    ].join("\n"),
    errors: [
      { messageId: "runnerOutsideBoundary" },
      { messageId: "syncSchemaInEffect" },
      { messageId: "nativePromise" },
      { messageId: "platformEffect" },
      { messageId: "platformEffect" }
    ],
    languageOptions: {
      parserOptions: { project: false, projectService: false }
    }
  },
  {
    filename: absolute("effect-boundary-invalid.mjs"),
    code: [
      'import { Effect, Schema } from "effect"',
      "Effect.runPromise[key].call(undefined, program)",
      "Effect.sync(() => Schema.decodeUnknownSync[key].call(Schema, Schema.String)(input))",
      "Promise.resolve[key].call(Promise, value)"
    ].join("\n"),
    errors: [
      { messageId: "runnerOutsideBoundary" },
      { messageId: "syncSchemaInEffect" },
      { messageId: "nativePromise" }
    ],
    languageOptions: {
      parserOptions: { project: false, projectService: false }
    }
  },
  {
    filename: absolute("effect-boundary-invalid.mjs"),
    code: [
      'import { URL as NodeURL } from "node:url"',
      "consume(NodeURL.createObjectURL)",
      "consume(NodeURL.revokeObjectURL)"
    ].join("\n"),
    errors: Array.from({ length: 2 }, () => ({ messageId: "platformEffect" })),
    languageOptions: {
      parserOptions: { project: false, projectService: false }
    }
  },
  {
    filename: absolute("effect-boundary-invalid.mjs"),
    code: [
      'import { URL as NodeURL } from "node:url"',
      "const { createObjectURL, revokeObjectURL: revoke } = NodeURL",
      "consume(createObjectURL)",
      "consume(revoke)"
    ].join("\n"),
    errors: Array.from({ length: 2 }, () => ({ messageId: "platformEffect" })),
    languageOptions: {
      parserOptions: { project: false, projectService: false }
    }
  },
  {
    filename: absolute("effect-boundary-invalid.mjs"),
    code: 'import("./local-module.js")',
    errors: [{ messageId: "promiseSignature" }],
    languageOptions: {
      parserOptions: { project: false, projectService: false }
    }
  },
  {
    filename: absolute("effect-boundary-invalid.mjs"),
    code: [
      "Promise.resolve.call(Promise, 1)",
      "const NativePromise = Promise.bind(undefined)",
      "new NativePromise((resolve) => resolve(1))",
      "pending.then.call(pending, use)",
      "URL.createObjectURL.call(URL, blob)",
      "fetch.bind(globalThis)(url)",
      "new (WebSocket.bind(undefined))(url)",
      'target.addEventListener.call(target, "event", receive)',
      "resource.close.bind(resource)",
      "consume(globalThis.fetch)",
      "consume(URL.createObjectURL)"
    ].join("\n"),
    errors: [
      { messageId: "nativePromise" },
      { messageId: "nativePromise" },
      { messageId: "promiseChain" },
      ...Array.from({ length: 7 }, () => ({ messageId: "platformEffect" }))
    ],
    languageOptions: {
      parserOptions: { project: false, projectService: false }
    }
  },
  {
    filename: absolute("effect-boundary-invalid.mjs"),
    code: [
      'import { Effect, Schema } from "effect"',
      "const produce = () => Promise.resolve(1)",
      "const recover = (error) => Schema.decodeUnknownSync(Schema.String)(error)",
      "const callbacks = { try: produce, catch: recover }",
      "const empty = { value: 1 }",
      "const options = { ...callbacks, ...empty }",
      "Effect.tryPromise(options)"
    ].join("\n"),
    errors: [{ messageId: "syncSchemaInEffect" }],
    languageOptions: {
      parserOptions: { project: false, projectService: false }
    }
  },
  {
    filename: absolute("effect-boundary-invalid.mjs"),
    code: [
      'import { Effect, Schema } from "effect"',
      "const overwrittenProducer = () => Promise.resolve(1)",
      "const recover = (error) => Schema.decodeUnknownSync(Schema.String)(error)",
      "const matchRecover = (error) => Schema.decodeUnknownSync(Schema.String)(error)",
      "const selectedProducer = () => Promise.resolve(2)",
      "const replacement = { try: () => host(), catch: identity }",
      "Effect.tryPromise({ try: overwrittenProducer, ...replacement })",
      "Effect.tryPromise({ try: overwrittenProducer, try: () => host() })",
      "Effect.tryPromise({ try: () => host(), catch: recover, ...replacement })",
      "const { producer: tryFn, recover: body } = { producer: selectedProducer, recover }",
      "Effect.tryPromise(tryFn)",
      "Effect.sync(body)",
      "const handlers = { onFailure: matchRecover, onSuccess: identity }",
      "Effect.match(program, handlers)"
    ].join("\n"),
    errors: [
      { messageId: "nativePromise", line: 2, column: 35 },
      { messageId: "syncSchemaInEffect", line: 3, column: 28 },
      { messageId: "syncSchemaInEffect", line: 4, column: 33 }
    ],
    languageOptions: {
      parserOptions: { project: false, projectService: false }
    }
  },
  {
    filename: absolute("effect-boundary-invalid.mjs"),
    code: [
      'import { Effect, Schema } from "effect"',
      "export const api = { first: Effect, second: Effect }",
      "export const tuple = [Effect, Schema]",
      "const unknown = source()",
      "export const conservative = { Effect, ...unknown }"
    ].join("\n"),
    errors: [
      { messageId: "runnerOutsideBoundary" },
      { messageId: "runnerOutsideBoundary" },
      { messageId: "runnerOutsideBoundary" },
      { messageId: "syncSchemaInEffect" },
      { messageId: "runnerOutsideBoundary" }
    ],
    languageOptions: {
      parserOptions: { project: false, projectService: false }
    }
  },
  {
    filename: absolute("effect-boundary-invalid.cjs"),
    code: [
      'module.exports.Fx = require("effect/Effect")',
      'module.exports.Schema = require("effect/Schema")',
      'const capabilities = { nested: { Fx: require("effect/Effect"), Schema: require("effect/Schema") } }',
      "exports.api = capabilities"
    ].join("\n"),
    errors: [
      { messageId: "runnerOutsideBoundary" },
      { messageId: "syncSchemaInEffect" },
      { messageId: "runnerOutsideBoundary" },
      { messageId: "syncSchemaInEffect" }
    ],
    languageOptions: {
      parserOptions: { project: false, projectService: false }
    }
  },
  {
    filename: absolute("effect-boundary-invalid.cjs"),
    code: [
      'const { URL: { createObjectURL, revokeObjectURL: revoke } } = require("node:url")',
      "consume(createObjectURL)",
      "consume(revoke)",
      'module.exports[key] = require("effect/Effect")',
      'exports[key] = require("effect/Schema")'
    ].join("\n"),
    errors: [
      { messageId: "platformEffect" },
      { messageId: "platformEffect" },
      { messageId: "runnerOutsideBoundary" },
      { messageId: "syncSchemaInEffect" }
    ],
    languageOptions: {
      parserOptions: { project: false, projectService: false }
    }
  },
  {
    filename: absolute("effect-boundary-invalid.cts"),
    code: 'import Effect = require("effect/Effect")\nexport = Effect',
    errors: [{ messageId: "runnerOutsideBoundary" }],
    languageOptions: {
      parserOptions: { project: false, projectService: false }
    }
  },
  {
    filename: absolute("effect-boundary-invalid.cts"),
    code: [
      'import Effect = require("effect/Effect")',
      'import Schema = require("effect/Schema")',
      "export = { Effect, Schema }"
    ].join("\n"),
    errors: [
      { messageId: "runnerOutsideBoundary" },
      { messageId: "syncSchemaInEffect" }
    ],
    languageOptions: {
      parserOptions: { project: false, projectService: false }
    }
  }
]

runRuleTester(valid, invalid)
