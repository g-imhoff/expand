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

const runnerBoundary = {
  file: "effect-boundary-valid.ts",
  declaration: "module:<module>",
  host: "Test application entrypoint",
  construct: "runner:Effect.runPromise",
  occurrence: 0
}

const valid = [
  validCase('import { Effect } from "effect"\nexport const load = Effect.fn("load")(function*() { return yield* Effect.tryPromise(() => host()) })'),
  validCase('import { Effect as Fx } from "effect"\nconst traced = Fx.fn\nexport const load = traced("load")(function*() { return yield* Fx.succeed(1) })'),
  validCase('import * as Fx from "effect/Effect"\nconst untraced = Fx.fnUntraced\nexport const load = untraced(function*() { return yield* Fx.succeed(1) })'),
  validCase('import { Effect } from "effect"\nEffect.tryPromise(() => new Promise((resolve) => resolve(1)))'),
  validCase('import { Effect } from "effect"\nEffect.tryPromise((): Promise<string> => host())'),
  validCase("const Promise = class {}\nnew Promise()"),
  validCase("type PromiseLike<Value> = { readonly value: Value }\ntype Result = PromiseLike<string>"),
  validCase("export const add = (left, right) => left + right"),
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
  withBoundaries(
    validCase('import { Effect } from "effect"\nEffect.runPromise(program)'),
    [runnerBoundary]
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
  {
    filename: absolute("effect-boundary-valid.mts"),
    code: 'const value = import.meta.url\nexport { value }',
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
  }
]

const invalid = [
  invalidCase("async function load() {}", [{ messageId: "nativeAsync" }]),
  invalidCase("const load = async () => await host()", [{ messageId: "nativeAsync" }, { messageId: "nativeAwait" }]),
  invalidCase("new Promise(() => undefined)", [{ messageId: "nativePromise" }]),
  invalidCase("const NativePromise = Promise\nnew NativePromise(() => undefined)", [{ messageId: "nativePromise" }]),
  invalidCase("Promise.all([host()])\nPromise.resolve(1)", [{ messageId: "nativePromise" }, { messageId: "nativePromise" }]),
  invalidCase("type Result = PromiseLike<string>", [{ messageId: "promiseSignature" }]),
  invalidCase("interface Api { load(): Promise<string> }", [{ messageId: "promiseSignature" }]),
  invalidCase("type Results<T> = { [Key in keyof T]: PromiseLike<T[Key]> }", [{ messageId: "promiseSignature" }]),
  invalidCase("declare const host: { then(consume: (value: string) => unknown): unknown }\nconst load = () => host", [{ messageId: "promiseSignature" }]),
  invalidCase("host().then(use)", [{ messageId: "promiseChain" }]),
  invalidCase("host().catch(recover).finally(cleanup)", [{ messageId: "promiseChain" }, { messageId: "promiseChain" }]),
  invalidCase("const value = process.env.HOME", [{ messageId: "platformEffect" }]),
  invalidCase('import { readFile as read } from "node:fs/promises"\nread(file)', [{ messageId: "platformEffect" }]),
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
  invalidCase('import { Effect } from "effect"\nEffect.runPromise(program)', [{ messageId: "runnerOutsideBoundary" }]),
  invalidCase('import { Effect as Fx } from "effect"\nconst { runPromise: run } = Fx\nrun(program)', [{ messageId: "runnerOutsideBoundary" }]),
  invalidCase('import { runPromise as run } from "effect/Effect"\nrun(program)', [{ messageId: "runnerOutsideBoundary" }]),
  invalidCase('import * as EffectPackage from "effect"\nEffectPackage.Effect.runPromise(program)', [{ messageId: "runnerOutsideBoundary" }]),
  invalidCase('import * as EffectPackage from "effect"\nconst { Effect: Fx } = EffectPackage\nFx.runPromise(program)', [{ messageId: "runnerOutsideBoundary" }]),
  invalidCase('import { Runtime as EffectRuntime } from "effect"\nEffectRuntime.runPromise(runtime)(program)', [{ messageId: "runnerOutsideBoundary" }]),
  invalidCase('import { NodeRuntime as Runtime } from "@effect/platform-node"\nRuntime.runMain(program)', [{ messageId: "runnerOutsideBoundary" }]),
  invalidCase('import { NodeRuntime as Runtime } from "@effect/platform-node"\nprogram.pipe(Runtime.runMain)', [{ messageId: "runnerOutsideBoundary" }]),
  invalidCase('import * as Platform from "@effect/platform-node"\nPlatform.NodeRuntime.runMain(program)', [{ messageId: "runnerOutsideBoundary" }]),
  invalidCase('import { ManagedRuntime as Runtime } from "effect"\nconst runtime = Runtime.make(layer)\nruntime.runPromise(program)', [{ messageId: "runnerOutsideBoundary" }]),
  invalidCase('import { Effect } from "effect"\nexport const load = () => Effect.succeed(1)', [{ messageId: "effectFunctionBoundary" }]),
  invalidCase('import { Effect } from "effect"\nexport function load() { return Effect.succeed(1) }', [{ messageId: "effectFunctionBoundary" }]),
  invalidCase('import { Effect } from "effect"\nconst load = () => Effect.succeed(1)\nexport { load }', [{ messageId: "effectFunctionBoundary" }]),
  invalidCase('import { Effect, Schema } from "effect"\nEffect.gen(function*() { return Schema.decodeUnknownSync(Schema.String)(input) })', [{ messageId: "syncSchemaInEffect" }]),
  invalidCase('import { Effect as Fx, Schema as S } from "effect"\nconst { decodeSync: decode } = S\nFx.sync(() => decode(S.String)(input))', [{ messageId: "syncSchemaInEffect" }]),
  withBoundaries(
    invalidCase('import { Effect } from "effect"\nEffect.runPromise(first)\nEffect.runPromise(second)', [{ messageId: "runnerOutsideBoundary" }]),
    [{ ...runnerBoundary, file: "effect-boundary-invalid.ts" }]
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
  }
]

ruleTester.run("effect-boundary", effectBoundary, { valid, invalid })
