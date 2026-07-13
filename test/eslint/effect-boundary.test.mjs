import { RuleTester } from "eslint"
import tseslint from "typescript-eslint"
import { describe, expect, it } from "vitest"
import { analyzeEffectBoundaryProgram } from "../../eslint-rules/effect-boundary-analysis.mjs"
import { effectBoundary } from "../../eslint-rules/effect-boundary.mjs"

RuleTester.describe = describe
RuleTester.it = it
RuleTester.itOnly = it.only

const repositoryRoot = new URL("../../", import.meta.url)
const absolute = (relative) => new URL(relative, repositoryRoot).pathname
const analyze = (code) => {
  const filename = absolute("effect-boundary-invalid.ts")
  const parsed = tseslint.parser.parseForESLint(code, { filePath: filename, loc: true, range: true, sourceType: "module" })
  return analyzeEffectBoundaryProgram({
    filename,
    sourceCode: {
      ast: parsed.ast,
      parserServices: parsed.services,
      scopeManager: parsed.scopeManager,
      visitorKeys: parsed.visitorKeys
    },
    parserServices: parsed.services
  })
}
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
  validCase('import { Effect } from "effect"\nexport const inspect = (value: unknown) => Effect.isEffect(value)'),
  validCase("export const data = () => ({ then: 1 })"),
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
  validCase("export {}\nclass EventTarget { addEventListener() {} }\nconst target = new EventTarget()\ntarget.addEventListener()"),
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
  },
  {
    filename: absolute("effect-boundary-pure-helper.mts"),
    code: 'import { Effect } from "effect"\nexport const inspect = (value: unknown) => Effect.isEffect(value)',
    languageOptions: { parserOptions: { project: false, projectService: false } }
  },
  {
    filename: absolute("effect-boundary-request-unsafe.mts"),
    code: 'import { Effect } from "effect"\nexport const register = (request, options) => Effect.requestUnsafe(request, options)',
    languageOptions: { parserOptions: { project: false, projectService: false } }
  },
  {
    filename: absolute("effect-boundary-replicate.mts"),
    code: 'import { Effect } from "effect"\nexport const copies = (program, times) => Effect.replicate(program, times)',
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
  {
    ...invalidCase('import { Effect } from "effect"\nexport const load = () => Effect.succeed(1)', [{ messageId: "effectFunctionBoundary" }]),
    filename: absolute("effect-boundary-effect-producer.mts"),
    languageOptions: { parserOptions: { project: false, projectService: false } }
  },
  {
    ...invalidCase('import { Effect } from "effect"\nexport const reject = (error) => Effect.fail(error)', [{ messageId: "effectFunctionBoundary" }]),
    filename: absolute("effect-boundary-fail-producer.mts"),
    languageOptions: { parserOptions: { project: false, projectService: false } }
  },
  {
    ...invalidCase('import { Effect } from "effect"\nexport const terminate = (defect) => Effect.die(defect)', [{ messageId: "effectFunctionBoundary" }]),
    filename: absolute("effect-boundary-die-producer.mts"),
    languageOptions: { parserOptions: { project: false, projectService: false } }
  },
  {
    ...invalidCase('import { Effect } from "effect"\nexport const requireValue = (option) => Effect.fromOption(option)', [{ messageId: "effectFunctionBoundary" }]),
    filename: absolute("effect-boundary-from-option-producer.mts"),
    languageOptions: { parserOptions: { project: false, projectService: false } }
  },
  {
    ...invalidCase('import { Effect } from "effect"\nexport const pause = (duration) => Effect.sleep(duration)', [{ messageId: "effectFunctionBoundary" }]),
    filename: absolute("effect-boundary-sleep-producer.mts"),
    languageOptions: { parserOptions: { project: false, projectService: false } }
  },
  invalidCase('import { Effect, Schema } from "effect"\nEffect.gen(function*() { return Schema.decodeUnknownSync(Schema.String)(input) })', [{ messageId: "syncSchemaInEffect" }]),
  invalidCase("Promise.resolve(1)", [{ messageId: "nativePromise" }]),
  invalidCase("const { resolve: settle } = Promise\nsettle(1)", [{ messageId: "nativePromise" }]),
  invalidCase('import { runPromise as run } from "effect/Effect"\nrun(program)', [{ messageId: "runnerOutsideBoundary" }]),
  invalidCase('import { Effect } from "effect"\nconst { runFork: run } = Effect\nrun(program)', [{ messageId: "runnerOutsideBoundary" }]),
  invalidCase('import * as Package from "effect"\nPackage.Effect.runPromise(program)', [{ messageId: "runnerOutsideBoundary" }]),
  invalidCase('import { Effect } from "effect"\nexport const run = (context, program) => Effect.runPromiseWith(context)(program)', [
    { messageId: "promiseSignature" },
    { messageId: "runnerOutsideBoundary" }
  ]),
  invalidCase('import { Effect } from "effect"\nexport const run = (context, program) => Effect.runSyncExitWith(context)(program)', [{ messageId: "runnerOutsideBoundary" }]),
  {
    ...invalidCase('import { Effect } from "effect"\nexport const run = (context, program) => Effect.runPromiseWith(context)(program)', [{ messageId: "runnerOutsideBoundary" }]),
    filename: absolute("effect-boundary-run-promise-with.mts"),
    languageOptions: { parserOptions: { project: false, projectService: false } }
  },
  {
    ...invalidCase('import { Effect } from "effect"\nexport const run = (context, program) => Effect.runSyncExitWith(context)(program)', [{ messageId: "runnerOutsideBoundary" }]),
    filename: absolute("effect-boundary-run-sync-exit-with.mts"),
    languageOptions: { parserOptions: { project: false, projectService: false } }
  },
  invalidCase('import * as Package from "effect"\nconst RuntimeApi = Package.Runtime\nRuntimeApi.runPromise(runtime)(program)', [{ messageId: "runnerOutsideBoundary" }]),
  invalidCase('import * as Package from "effect"\nconst { ManagedRuntime: ManagedRuntimeApi } = Package\nManagedRuntimeApi.runSync(runtime)(program)', [{ messageId: "runnerOutsideBoundary" }]),
  invalidCase('import * as Package from "effect"\nconst { Effect: Fx, Schema: S } = Package\nFx.sync(() => S.decodeUnknownSync(S.String)(input))', [{ messageId: "syncSchemaInEffect" }]),
  invalidCase('import * as Platform from "@effect/platform-node"\nPlatform.NodeRuntime.runMain(program)', [{ messageId: "runnerOutsideBoundary" }]),
  invalidCase('import { Effect as Program } from "effect"\nexport function load(): Program.Effect<number> { return Program.succeed(1) }', [{ messageId: "effectFunctionBoundary" }]),
  invalidCase('import { Effect } from "effect"\nexport const load = () => ({ then(resolve: (value: number) => void) { resolve(1) } })', [{ messageId: "promiseSignature" }]),
  invalidCase('import { Effect, Schema as S } from "effect"\nconst { encodeSync: encode } = S\nEffect.sync(() => encode(S.String)(input))', [{ messageId: "syncSchemaInEffect" }]),
  invalidCase('import * as Effect from "effect/Effect"\nimport * as Schema from "effect/Schema"\nEffect.fn("load")(() => Schema.decodeSync(Schema.String)(input))', [{ messageId: "syncSchemaInEffect" }]),
  invalidCase('import { readFile as load } from "node:fs"\nload(path, callback)', [{ messageId: "platformEffect" }]),
  invalidCase('import constants from "node:constants"\nvoid constants', [{ messageId: "platformEffect" }]),
  invalidCase('import dgram from "node:dgram"\nvoid dgram', [{ messageId: "platformEffect" }]),
  invalidCase('import domain from "node:domain"\nvoid domain', [{ messageId: "platformEffect" }]),
  invalidCase('import sea from "node:sea"\nvoid sea', [{ messageId: "platformEffect" }]),
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
  invalidCase('declare const target: EventTarget\ntarget.addEventListener("click", work)', [{ messageId: "platformEffect" }]),
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

it("canonicalizes the platform package NodeRuntime namespace construct", () => {
  const analysis = analyze('import * as Platform from "@effect/platform-node"\nPlatform.NodeRuntime.runMain(program)')
  expect(analysis.occurrences).toMatchObject([
    { messageId: "runnerOutsideBoundary", identity: { construct: "runner:NodeRuntime.runMain" } }
  ])
})

it("preserves exact curried Effect runner constructs", () => {
  const analysis = analyze('import { Effect } from "effect"\nEffect.runPromiseWith(context)(first)\nEffect.runSyncExitWith(context)(second)')
  expect(analysis.occurrences).toMatchObject([
    { messageId: "runnerOutsideBoundary", identity: { construct: "runner:Effect.runPromiseWith" } },
    { messageId: "runnerOutsideBoundary", identity: { construct: "runner:Effect.runSyncExitWith" } }
  ])
})

it("assigns stable PromiseLike identities to mapped and member declarations", () => {
  const identity = (code) => analyze(code).occurrences.find((occurrence) => occurrence.messageId === "promiseSignature")?.identity
  const mapped = identity("type AsyncFields<T> = { [K in keyof T]: () => PromiseLike<T[K]> }")
  const mappedSpaced = identity("type AsyncFields<T> = {\n  [K in keyof T]: () => PromiseLike<T[K]>\n}")
  const member = identity("interface Service { load(): PromiseLike<string> }")
  const memberSpaced = identity("interface Service {\n  load(): PromiseLike<string>\n}")

  expect(mapped).toEqual({
    file: "effect-boundary-invalid.ts",
    declaration: "type:AsyncFields",
    construct: "signature:PromiseLike",
    occurrence: 0
  })
  expect(mappedSpaced).toEqual(mapped)
  expect(member).toEqual({
    file: "effect-boundary-invalid.ts",
    declaration: "member:Service.load",
    construct: "signature:PromiseLike",
    occurrence: 0
  })
  expect(memberSpaced).toEqual(member)
})

it("assigns stable fallback identities across selected syntax kinds", () => {
  const fallbackConstruct = "platform:shared-fallback"
  const identities = (code) => {
    const analysis = analyze(code)
    const importOffset = code.indexOf("node:fs")
    const timerOffset = code.indexOf(",") + 1
    return {
      imported: analysis.identityAtOffset(importOffset, fallbackConstruct),
      repeated: analysis.identityAtOffset(timerOffset, fallbackConstruct),
      timer: analysis.identityAtOffset(timerOffset, fallbackConstruct)
    }
  }
  const compact = identities('import fs from "node:fs"\nsetTimeout(work, 1)')
  const spaced = identities('import   fs   from   "node:fs"\n\n\nsetTimeout( work , 1 )')

  expect(compact.imported).toMatchObject({ declaration: "module:<module>", construct: fallbackConstruct })
  expect(compact.timer).toMatchObject({ declaration: "module:<module>", construct: fallbackConstruct })
  expect(compact.imported.occurrence).toBeLessThan(compact.timer.occurrence)
  expect(compact.repeated).toEqual(compact.timer)
  expect(spaced.imported).toEqual(compact.imported)
  expect(spaced.timer).toEqual(compact.timer)
})
