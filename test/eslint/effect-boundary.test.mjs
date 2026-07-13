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
const withBoundaries = ({ boundary: entryBoundary, ...entry }) => ({ ...entry, options: [[entryBoundary]] })
const boundary = (overrides = {}) => ({
  file: "effect-boundary-valid.ts",
  declaration: "module:<module>",
  host: "Test host",
  construct: "runner:NodeRuntime.runMain",
  occurrence: 0,
  ...overrides
})
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

const valid = [
  validCase('import { Effect } from "effect"\nexport const load = Effect.fn("load")(function*() { return yield* Effect.tryPromise(() => host()) })'),
  validCase("const Promise = class {}\nnew Promise()"),
  validCase("export const add = (left, right) => left + right"),
  validCase('import { Effect as Fx } from "effect"\nconst wrap = Fx.fn\nexport const load = wrap("load")(() => Fx.succeed(1))'),
  validCase('import * as Fx from "effect/Effect"\nconst { fnUntraced: wrap } = Fx\nexport const load = wrap("load")(() => Fx.succeed(1))'),
  validCase('import { Effect } from "effect"\nEffect.tryPromise(() => host().then(use))'),
  validCase('import { Schema } from "effect"\nSchema.decodeUnknownSync(Schema.String)(input)'),
  validCase("const Effect = { runPromise: (value) => value }\nEffect.runPromise(program)"),
  validCase("const Schema = { decodeUnknownSync: () => () => 1 }\nSchema.decodeUnknownSync()(input)"),
  validCase("const process = { env: { HOME: '' } }\nconst value = process.env.HOME"),
  validCase("const Date = { now: () => 0 }\nconst console = { log: () => undefined }\nDate.now()\nconsole.log('ok')"),
  validCase("const fetch = () => 1\nconst window = {}\nconst document = {}\nconst localStorage = {}\nfetch('/')\nvoid window\nvoid document\nvoid localStorage"),
  validCase('import { Effect } from "effect"\nitems.map(() => Effect.succeed(1))'),
  validCase("const parsed = new URL('./worker.js', import.meta.url)\nexport { parsed }"),
  withBoundaries({
    ...validCase('import { NodeRuntime } from "@effect/platform-node"\nNodeRuntime.runMain(program)'),
    boundary: boundary()
  }),
  {
    filename: absolute("effect-boundary-valid.mts"),
    code: "export const location = import.meta.url",
    languageOptions: { parserOptions: { project: false, projectService: false } }
  },
  {
    filename: absolute("effect-boundary-valid.cts"),
    code: "export = { value: 1 }",
    languageOptions: { parserOptions: { project: false, projectService: false } }
  }
]

const invalid = [
  invalidCase("async function load() {}", [{ messageId: "nativeAsync" }]),
  invalidCase("const load = async () => await host()", [{ messageId: "nativeAsync" }, { messageId: "nativeAwait" }]),
  invalidCase("new Promise(() => undefined)", [{ messageId: "nativePromise" }]),
  invalidCase("type Result = PromiseLike<string>", [{ messageId: "promiseSignature" }]),
  invalidCase("host().then(use)", [{ messageId: "promiseChain" }]),
  invalidCase("const value = process.env.HOME", [{ messageId: "platformEffect" }]),
  invalidCase('import { Effect } from "effect"\nEffect.runPromise(program)', [{ messageId: "runnerOutsideBoundary" }]),
  invalidCase('import { Effect } from "effect"\nexport const load = () => Effect.succeed(1)', [{ messageId: "effectFunctionBoundary" }]),
  invalidCase('import { Effect, Schema } from "effect"\nEffect.gen(function*() { return Schema.decodeUnknownSync(Schema.String)(input) })', [{ messageId: "syncSchemaInEffect" }]),
  invalidCase("Promise.resolve(1)", [{ messageId: "nativePromise" }]),
  invalidCase("const { resolve: settle } = Promise\nsettle(1)", [{ messageId: "nativePromise" }]),
  invalidCase('import { runPromise as run } from "effect/Effect"\nrun(program)', [{ messageId: "runnerOutsideBoundary" }]),
  invalidCase('import { Effect } from "effect"\nconst { runFork: run } = Effect\nrun(program)', [{ messageId: "runnerOutsideBoundary" }]),
  invalidCase('import { Effect as Program } from "effect"\nexport function load(): Program.Effect<number> { return Program.succeed(1) }', [{ messageId: "effectFunctionBoundary" }]),
  invalidCase('import { Effect } from "effect"\nexport const load = () => ({ then(resolve: (value: number) => void) { resolve(1) } })', [{ messageId: "promiseSignature" }]),
  invalidCase('import { Effect, Schema as S } from "effect"\nconst { encodeSync: encode } = S\nEffect.sync(() => encode(S.String)(input))', [{ messageId: "syncSchemaInEffect" }]),
  invalidCase('import * as Effect from "effect/Effect"\nimport * as Schema from "effect/Schema"\nEffect.fn("load")(() => Schema.decodeSync(Schema.String)(input))', [{ messageId: "syncSchemaInEffect" }]),
  invalidCase('import { readFile as load } from "node:fs"\nload(path, callback)', [{ messageId: "platformEffect" }]),
  invalidCase("console.log('value')", [{ messageId: "platformEffect" }]),
  invalidCase("setTimeout(work, 1)\nqueueMicrotask(work)", [{ messageId: "platformEffect" }, { messageId: "platformEffect" }]),
  invalidCase("Date.now()\nperformance.now()\nMath.random()\ncrypto.randomUUID()", [
    { messageId: "platformEffect" },
    { messageId: "platformEffect" },
    { messageId: "platformEffect" },
    { messageId: "platformEffect" }
  ]),
  invalidCase("fetch(url)\nnew WebSocket(url)\nlocalStorage.getItem('key')\ndocument.addEventListener('click', work)", [
    { messageId: "platformEffect" },
    { messageId: "platformEffect" },
    { messageId: "platformEffect" },
    { messageId: "platformEffect" }
  ]),
  {
    ...invalidCase('import { NodeRuntime } from "@effect/platform-node"\nNodeRuntime.runMain(first)\nNodeRuntime.runMain(second)', [
      { messageId: "runnerOutsideBoundary", line: 3 }
    ]),
    options: [[boundary({ occurrence: 0, file: "effect-boundary-invalid.ts" })]]
  },
  {
    ...invalidCase("export const value = 1", [{ messageId: "staleBoundary" }]),
    options: [[boundary({ file: "effect-boundary-invalid.ts" })]]
  },
  {
    ...invalidCase("class Service { run() { return process.env.HOME } }", [{ messageId: "platformEffect" }]),
    options: [[]]
  },
  {
    ...invalidCase("const { HOME: home } = process.env", [{ messageId: "platformEffect" }]),
    options: [[]]
  }
]

ruleTester.run("effect-boundary", effectBoundary, { valid, invalid })
