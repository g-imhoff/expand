# Effect-Only Audit Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install an authoritative whole-repository Effect policy, expose the requested broad grep command, and freeze every existing violation in exact monotonically shrinking inventories before runtime migration begins.

**Architecture:** One dedicated TypeScript project covers every tracked first-party TS-family file. The official Effect language service supplies supported Effect v4 diagnostics, a binding- and type-aware local ESLint rule supplies repository policy, and one Effect-native audit program normalizes both engines plus executable launchers into stable declaration identities. Exact permanent host boundaries are separate from temporary migration debt. A second exact inventory classifies every broad grep candidate.

**Tech Stack:** Node.js 24.15 or newer, npm 11, TypeScript 6.0.3, Effect 4.0.0-beta.74, `@effect/vitest` 4.0.0-beta.74, `@effect/language-service` 0.86.6, ESLint 10, typescript-eslint 8.61, Vitest 4.1, ripgrep.

## Global Constraints

- This is plan 1 of the migration defined by `docs/superpowers/specs/2026-07-13-effect-only-codebase-design.md`; completing it does not complete the repository conversion.
- Pin `@effect/vitest`, Effect, and every first-party Effect package at `4.0.0-beta.74`, TypeScript at `6.0.3`, and `@effect/language-service` at `0.86.6`.
- Use the single `tsconfig.effect-audit.json` project in the authoritative audit. Root and desktop diagnostic scripts are debugging conveniences only.
- Run language-service diagnostics with `--severity error,message`; do not baseline unrelated default warnings.
- Do not configure `schemaSyncInEffect`; version 0.86.6 exposes that rule for Effect v3 only. The typed local rule blocks synchronous Schema decoding or encoding inside Effect v4.
- `effectFnOpportunity` is advisory. The local semantic rule blocks exported named Effect-returning functions that omit `Effect.fn` or `Effect.fnUntraced`.
- Permanent TypeScript and JavaScript host boundaries identify one file, one declaration, one host, one construct, and one occurrence. Globs, directories, and whole-source exemptions are invalid. Executable launchers additionally carry an exact source digest.
- The semantic migration baseline and every `migration-debt` inventory subset may only shrink after initial capture. Exact non-debt grep or launcher classifications may be added or fingerprint-updated only by an explicit reviewed registry edit; update commands never infer or add them.
- Pure deterministic functions remain ordinary functions. The audit must not require them to return Effect.
- Do not add code comments.
- Every task is implemented by a fresh project `tdd-implementer`, then reviewed by a fresh project `task-reviewer`. Send all Critical and Important findings through one fresh fix wave and repeat the gate before continuing.
- Never dispatch parallel tracked-tree writers.

---

## File responsibility map

- `tsconfig.effect-audit.json`: one semantic program containing all tracked first-party TS, TSX, MTS, and CTS inputs.
- `tsconfig.json`: inherited language-service editor configuration.
- `eslint-rules/effect-boundary-analysis.mjs` plus `.d.mts`: binding, type, declaration, construct, occurrence identity, and its TypeScript reuse contract.
- `eslint-rules/effect-boundary-policy.mjs`: enumerated Promise, runner, platform, and named-Effect policy.
- `eslint-rules/effect-boundary.mjs`: repository rule and exact permanent-boundary consumption.
- `eslint-rules/effect-host-boundaries.mjs` plus `.d.mts`: permanent host-required constructs and their TypeScript reuse contract.
- `eslint.effect.config.mjs`: whole-tree semantic ESLint project.
- `scripts/effect-policy-model.ts`: schemas for permanent boundaries and stable source identities.
- `scripts/effect-audit-model.ts`: normalized findings and strict-subset comparisons.
- `scripts/effect-audit.ts`: Effect-native diagnostic, ESLint, Git, grep, and registry orchestration.
- `scripts/effect-inventory-model.ts`: grep-candidate and executable-launcher schemas, fingerprints, and debt comparisons.
- `effect-audit-baseline.json`: temporary exact semantic migration debt.
- `effect-grep-inventory.json`: exact classification of every broad grep candidate.
- `effect-launchers.json`: exact tracked executable-host registry.
- `docs/architecture/EFFECT_ONLY.md`: contributor-facing invariant protected by CODEOWNERS.

---

### Task 1: Install official Effect diagnostics and prove semantic coverage

**Files:**
- Create: `tsconfig.effect-audit.json`
- Create: `test/architecture/effect-language-service.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tsconfig.json`

**Interfaces:**
- Produces: `npm run effect:diagnostics`, the authoritative JSON diagnostic command for `tsconfig.effect-audit.json`.
- Produces: `npm run effect:diagnostics:root` and `npm run effect:diagnostics:desktop` for local diagnosis only.
- Produces: `npm run typecheck:effect-audit`, an ordinary compiler check for the dedicated project.
- Consumes: `it.effect` from the exact compatible `@effect/vitest` beta.

- [ ] **Step 1: Add the failing configuration and coverage test**

Create `test/architecture/effect-language-service.test.ts` with `it.effect` from `@effect/vitest`. Read JSON through `FileSystem.FileSystem` and Schema. Define `trackedTypeScriptFiles` as an `Effect.fn` that runs `git ls-files --cached --others --exclude-standard -z`, filters `.ts`, `.tsx`, `.mts`, and `.cts`, and normalizes with the Effect `Path` service. Define `resolvedAuditFiles` as an `Effect.fn` that runs `npm exec -- tsc --listFilesOnly -p tsconfig.effect-audit.json`, retains repository-owned TS-family paths, and normalizes them through the same function. Both helpers acquire `ChildProcess.make` in `Effect.scoped`, drain stdout and stderr concurrently with `Stream.decodeText` and `Stream.mkString`, require exit code `0`, and return sorted arrays.

Use these exact configuration schemas, so the test does not use `JSON.parse` or casts:

```ts
const StringMap = Schema.Record(Schema.String, Schema.String)
const PackageJson = Schema.fromJsonString(Schema.Struct({
  scripts: StringMap,
  devDependencies: StringMap
}))
const PluginJson = Schema.Struct({
  name: Schema.String,
  diagnosticSeverity: Schema.optionalKey(StringMap)
})
const RootConfigJson = Schema.fromJsonString(Schema.Struct({
  compilerOptions: Schema.Struct({ plugins: Schema.Array(PluginJson) })
}))
const AuditConfigJson = Schema.fromJsonString(Schema.Struct({
  extends: Schema.String,
  include: Schema.Array(Schema.String),
  exclude: Schema.Array(Schema.String)
}))
const DesktopConfigJson = Schema.fromJsonString(Schema.Struct({ extends: Schema.String }))

const readJson = Effect.fn("EffectAuditTest.readJson")(
  function* <S extends Schema.Top>(file: string, schema: S) {
    const fs = yield* FileSystem.FileSystem
    return yield* Schema.decodeUnknownEffect(schema)(yield* fs.readFileString(file))
  }
)

const runText = Effect.fn("EffectAuditTest.runText")(
  (command: string, args: ReadonlyArray<string>) =>
    Effect.scoped(Effect.gen(function*() {
      const handle = yield* ChildProcess.make(command, args)
      const [stdout, stderr, exitCode] = yield* Effect.all([
        handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
        handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
        handle.exitCode
      ], { concurrency: "unbounded" })
      if (exitCode !== 0) {
        return yield* Effect.fail({ command, args, exitCode, stderr } as const)
      }
      return stdout
    }))
)
```

Then compare canonical repository-relative sets:

```ts
it.effect("covers every tracked TypeScript source with the Effect audit project", () =>
  Effect.gen(function*() {
    const tracked = yield* trackedTypeScriptFiles
    const resolved = yield* resolvedAuditFiles
    expect(resolved).toEqual(tracked)
  }).pipe(Effect.provide(NodeServices.layer)))
```

Add assertions for the exact dependency versions, scripts, plugin order, supported diagnostic severities, generated-directory exclusions, and absence of `schemaSyncInEffect`. Set equality is authoritative; do not assert a fixed file count. Including untracked, non-ignored sources keeps the TDD cycle valid before the new test is staged.

- [ ] **Step 2: Verify the red state**

Run:

```bash
npm exec -- vitest run test/architecture/effect-language-service.test.ts
```

Expected: FAIL because both pinned packages, the audit project, and the diagnostic scripts are absent.

- [ ] **Step 3: Install exact compatible packages**

Run:

```bash
npm install --save-dev --save-exact @effect/language-service@0.86.6 @effect/vitest@4.0.0-beta.74
```

Expected: `package.json` and `package-lock.json` pin the exact versions without moving Effect, TypeScript, or Vitest.

- [ ] **Step 4: Configure the audit project and supported diagnostics**

Create `tsconfig.effect-audit.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "types": ["node", "react", "react-dom"]
  },
  "include": [
    "apps",
    "packages",
    "scripts",
    "examples",
    "bench",
    "migrations",
    "test",
    "eslint-rules",
    "*.ts",
    "*.tsx",
    "*.mts",
    "*.cts"
  ],
  "exclude": ["**/node_modules/**", "**/dist/**", "**/out/**", "**/build/**", "**/coverage/**", "**/test-results/**", "**/playwright-report/**"]
}
```

Add this exact `@effect/language-service` object as the final root compiler plugin:

```json
{
  "name": "@effect/language-service",
  "diagnostics": true,
  "diagnosticsName": true,
  "includeSuggestionsInTsc": true,
  "ignoreEffectErrorsInTscExitCode": false,
  "ignoreEffectWarningsInTscExitCode": false,
  "ignoreEffectSuggestionsInTscExitCode": true,
  "diagnosticSeverity": {
    "asyncFunction": "error",
    "newPromise": "error",
    "nodeBuiltinImport": "error",
    "globalConsole": "error",
    "globalConsoleInEffect": "error",
    "globalDate": "error",
    "globalDateInEffect": "error",
    "globalFetch": "error",
    "globalFetchInEffect": "error",
    "globalRandom": "error",
    "globalRandomInEffect": "error",
    "globalTimers": "error",
    "globalTimersInEffect": "error",
    "cryptoRandomUUID": "error",
    "cryptoRandomUUIDInEffect": "error",
    "processEnv": "error",
    "processEnvInEffect": "error",
    "preferSchemaOverJson": "error",
    "floatingEffect": "error",
    "lazyPromiseInEffectSync": "error",
    "runEffectInsideEffect": "error",
    "tryCatchInEffectGen": "error",
    "globalErrorInEffectCatch": "error",
    "globalErrorInEffectFailure": "error",
    "effectFnOpportunity": "message"
  }
}
```

Omit `schemaSyncInEffect`; Task 2 owns the verified v4 check. Add these scripts:

```json
{
  "effect:diagnostics": "effect-language-service diagnostics --project tsconfig.effect-audit.json --format json --severity error,message",
  "effect:diagnostics:root": "effect-language-service diagnostics --project tsconfig.json --format json --severity error,message",
  "effect:diagnostics:desktop": "effect-language-service diagnostics --project apps/desktop/tsconfig.json --format json --severity error,message",
  "typecheck:effect-audit": "tsc --noEmit -p tsconfig.effect-audit.json"
}
```

The architecture test must prove the root, desktop, and audit projects inherit the same final plugin, while only the audit project is used as authoritative coverage.

- [ ] **Step 5: Verify supported diagnostics and full project coverage**

Run:

```bash
npm exec -- effect-language-service diagnostics --file packages/client-ts/backend-command.ts --format json
npm exec -- vitest run test/architecture/effect-language-service.test.ts
npm run typecheck:effect-audit
npm run typecheck:all
```

Expected: the single-file command exits 1 with a JSON `nodeBuiltinImport` finding; the architecture test and both typecheck commands PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.effect-audit.json test/architecture/effect-language-service.test.ts
git commit -m "build: add Effect diagnostics"
```

---

### Task 2: Add the binding- and type-aware repository rule

**Files:**
- Create: `eslint-rules/effect-boundary-analysis.mjs`
- Create: `eslint-rules/effect-boundary-analysis.d.mts`
- Create: `eslint-rules/effect-boundary-policy.mjs`
- Create: `eslint-rules/effect-boundary.mjs`
- Create: `eslint-rules/effect-host-boundaries.mjs`
- Create: `eslint-rules/effect-host-boundaries.d.mts`
- Create: `eslint.effect.config.mjs`
- Create: `test/eslint/effect-boundary.test.mjs`
- Modify: `eslint-rules/index.mjs`
- Modify: `eslint.config.mjs`

**Interfaces:**
- Produces: local ESLint rule `local/effect-boundary`.
- Produces: named `effectBoundary` export for RuleTester and the local plugin index.
- Produces: stable source identity `{ file, declaration, construct, occurrence }` for every finding and exemption.
- Produces: `effectHostBoundaries`, an immutable array of exact one-construct records.
- Produces: one typed whole-tree config for TS-family files and one syntax-only block for JS-family files.

- [ ] **Step 1: Write failing RuleTester coverage for every policy family**

Create `test/eslint/effect-boundary.test.mjs` with this fixed-filename typed RuleTester setup, so binding and checker cases receive parser services without opening an unbounded default project:

```js
import { RuleTester } from "eslint"
import tseslint from "typescript-eslint"
import { effectBoundary } from "../../eslint-rules/effect-boundary.mjs"

const repositoryRoot = new URL("../../", import.meta.url)
const absolute = (relative) => new URL(relative, repositoryRoot).pathname
const validCase = (code) => ({ filename: absolute("effect-boundary-valid.ts"), code })
const invalidCase = (code, errors) => ({ filename: absolute("effect-boundary-invalid.ts"), code, errors })
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
```

Use `effect-boundary-valid.ts` for every valid typed case and `effect-boundary-invalid.ts` for every invalid typed case. Exercise MTS and CTS parsing with two fixed extension-specific syntax cases that override parser options with `project: false` and `projectService: false`; all type-aware assertions stay on the two default-project filenames above. Add cases for aliases, shadowing, destructuring, inferred thenables, mapped/member declarations, MTS/CTS syntax, and exact exemption consumption. Include these core cases:

```js
const valid = [
  validCase('import { Effect } from "effect"\nexport const load = Effect.fn("load")(function*() { return yield* Effect.tryPromise(() => host()) })'),
  validCase("const Promise = class {}\nnew Promise()"),
  validCase("export const add = (left, right) => left + right")
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
  invalidCase('import { Effect, Schema } from "effect"\nEffect.gen(function*() { return Schema.decodeUnknownSync(Schema.String)(input) })', [{ messageId: "syncSchemaInEffect" }])
]

ruleTester.run("effect-boundary", effectBoundary, { valid, invalid })
```

Valid cases must prove direct Promise consumption by `Effect.tryPromise`, exported operations wrapped by direct or aliased `Effect.fn` and `Effect.fnUntraced`, local names shadowing `Promise`, `Effect`, `Schema`, `process`, `Date`, and browser globals, pure functions, anonymous protocol callbacks, and one exact matching host record. A second identical construct in the same declaration must require a distinct occurrence record. An unused configured record must report `staleBoundary`.

- [ ] **Step 2: Verify the red state**

Run:

```bash
npm exec -- vitest run test/eslint/effect-boundary.test.mjs
```

Expected: FAIL because the rule and analysis modules do not exist.

- [ ] **Step 3: Implement binding, type, declaration, and construct analysis**

Implement runtime exports from `effect-boundary-analysis.mjs` and put these exact declarations in `effect-boundary-analysis.d.mts`, so the TypeScript audit program can reuse the analyzer without an unsafe cast:

```ts
export interface SourceIdentity {
  readonly file: string
  readonly declaration: string
  readonly construct: string
  readonly occurrence: number
}

export interface BoundaryOccurrence {
  readonly messageId:
    | "nativeAsync"
    | "nativeAwait"
    | "nativePromise"
    | "promiseSignature"
    | "promiseChain"
    | "platformEffect"
    | "runnerOutsideBoundary"
    | "effectFunctionBoundary"
    | "syncSchemaInEffect"
  readonly identity: SourceIdentity
  readonly node: unknown
}

export interface EffectBoundaryAnalysis {
  readonly occurrences: ReadonlyArray<BoundaryOccurrence>
  readonly declarations: ReadonlySet<string>
  readonly identityOf: (node: unknown) => SourceIdentity
  readonly identityAtOffset: (offset: number, fallbackConstruct: string) => SourceIdentity
}

export declare const analyzeEffectBoundaryProgram: (input: {
  readonly filename: string
  readonly sourceCode: unknown
  readonly parserServices: unknown
}) => EffectBoundaryAnalysis
```

Create `effect-host-boundaries.d.mts` with the registry's exact structural type:

```ts
export interface EffectHostBoundary {
  readonly file: string
  readonly declaration: string
  readonly host: string
  readonly construct: string
  readonly occurrence: number
}

export declare const effectHostBoundaries: ReadonlyArray<EffectHostBoundary>
```

The ESLint rule calls `analyzeEffectBoundaryProgram` once from `Program`, reports its occurrences, and tracks exact registry consumption through `Program:exit`. The architecture validator calls the same export, so rule and registry identities cannot drift.

Resolve imports and aliases from `effect`, Effect subpaths, `@effect/platform-node`, and managed runtimes through scope bindings rather than identifier spelling. Resolve Schema namespaces and method aliases the same way. Use `context.sourceCode.parserServices.esTreeNodeToTSNodeMap` and `program.getTypeChecker()` for explicit and inferred `PromiseLike` and Effect return types. JS files retain syntax and ambient checks without parser services.

The policy module enumerates native async/await, Promise construction/statics/types/chains, Effect/Runtime/ManagedRuntime/NodeRuntime runners, exported named Effect functions, synchronous Schema decoders and encoders used within `Effect.gen`, `Effect.fn`, `Effect.sync`, or another recognized Effect callback, Node builtins, process state, console, timers and microtasks, time/performance, randomness and UUID, fetch/network constructors, filesystem, IPC, workers, MessagePorts, listeners, DOM/browser globals, and storage resources. Do not classify deterministic `URL` parsing or `import.meta.url`; they remain pure operations over supplied module/string values.

- [ ] **Step 4: Implement exact host-boundary matching and rule messages**

Use this record shape:

```js
{
  file: "apps/cli/cli/main.ts",
  declaration: "module:<module>",
  host: "Node application entrypoint",
  construct: "runner:NodeRuntime.runMain",
  occurrence: 0
}
```

Reject empty paths, directories, wildcard characters, duplicates, and records that match more than one occurrence. The rule exposes these messages: `nativeAsync`, `nativeAwait`, `nativePromise`, `promiseSignature`, `promiseChain`, `platformEffect`, `runnerOutsideBoundary`, `effectFunctionBoundary`, `syncSchemaInEffect`, and `staleBoundary`.

Seed only analyzer-proven permanent entry runners in `apps/cli/cli/main.ts` and `apps/server/main.ts`. Keep current Electron Promise seams and migration-era runners in temporary debt until the host-boundary plan gives them their final declarations.

- [ ] **Step 5: Add whole-tree semantic and layered ordinary ESLint configs**

Create `eslint.effect.config.mjs` over:

```js
const sourceFiles = ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"]
const generated = [
  "**/node_modules/**",
  "**/dist/**",
  "**/out/**",
  "**/build/**",
  "**/coverage/**",
  "**/test-results/**",
  "**/playwright-report/**"
]
```

TS-family files use `tseslint.parser` with `project: "./tsconfig.effect-audit.json"`; JS-family files use syntax-only parsing. Both enable `local/effect-boundary` as an error with `effectHostBoundaries`.

Remove the now-stale explanatory comment block from ordinary `eslint.config.mjs`. Replace the broad `eslint-rules/**` and `eslint.config.mjs` ignores with separate TS application, TS tooling, and pure JS infrastructure blocks. Preserve `local/module-order` and `local/no-export-star` only where their existing contracts apply. Do not enable the unbaselined Effect rule in ordinary lint yet.

- [ ] **Step 6: Verify focused behavior and repository scanning**

Run:

```bash
npm exec -- vitest run test/eslint/effect-boundary.test.mjs
npm exec -- eslint --config eslint.effect.config.mjs packages/client-ts/backend-command.ts --format json
npm run lint
npm run typecheck:effect-audit
```

Expected: RuleTester PASS; the standalone semantic lint exits 1 with exact findings; ordinary lint and the audit-project typecheck PASS.

- [ ] **Step 7: Commit**

```bash
git add eslint-rules/effect-boundary-analysis.mjs eslint-rules/effect-boundary-analysis.d.mts eslint-rules/effect-boundary-policy.mjs eslint-rules/effect-boundary.mjs eslint-rules/effect-host-boundaries.mjs eslint-rules/effect-host-boundaries.d.mts eslint-rules/index.mjs eslint.effect.config.mjs eslint.config.mjs test/eslint/effect-boundary.test.mjs
git commit -m "build: add Effect boundary rule"
```

---

### Task 3: Add exact policy validation and the monotonic audit engine

**Files:**
- Create: `scripts/effect-policy-model.ts`
- Create: `scripts/effect-audit-model.ts`
- Create: `scripts/effect-audit.ts`
- Create: `scripts/effect-audit.test.ts`
- Create: `effect-audit-baseline.json`
- Create: `test/architecture/effect-boundary-coverage.test.ts`
- Create: `test/architecture/effect-boundary-registry.test.ts`
- Modify: `eslint-rules/effect-host-boundaries.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `AuditFinding` keyed only by `{ engine, file, rule, declaration, construct, occurrence }`.
- Produces: `compareAudit` and `canUpdateBaseline`, where an update is valid only for a strict subset or identical set.
- Produces: `validateHostBoundaries`, which resolves every permanent record against tracked AST declarations and occurrences.
- Produces: injectable `AuditCommandRunner` and `runAudit({ root, mode })`, so command failure, normalization, and ratchet behavior are tested without editing tracked sources.
- Produces: `npm run effect:audit` and a shrink-only `npm run effect:audit:update`.

- [ ] **Step 1: Write failing model, command, coverage, and registry tests**

In `scripts/effect-audit.test.ts`, prove identity stability across line/excerpt changes, occurrence disambiguation, semantic deduplication, strict-subset updates, missing-baseline rejection, rejection of message-severity or duplicate baseline records, malformed command JSON, signals, invalid exit codes, and concurrent stdout/stderr draining. Create all filesystem fixtures under `FileSystem.makeTempDirectoryScoped`; use a fake `AuditCommandRunner` layer for complete `runAudit` tests and never add a temporary violation to the tracked repository.

Define the shared policy schema in `scripts/effect-policy-model.ts`:

```ts
import { Schema } from "effect"

export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

export class SourceIdentity extends Schema.Class<SourceIdentity>("SourceIdentity")({
  file: Schema.String,
  declaration: Schema.String,
  construct: Schema.String,
  occurrence: NonNegativeInt
}) {}

export class HostBoundary extends Schema.Class<HostBoundary>("HostBoundary")({
  file: Schema.String,
  declaration: Schema.String,
  host: Schema.String,
  construct: Schema.String,
  occurrence: NonNegativeInt
}) {}
```

Define the audit schema and error in `scripts/effect-audit-model.ts`:

```ts
import { Data, Schema } from "effect"
import { NonNegativeInt, PositiveInt } from "./effect-policy-model"

export class AuditFinding extends Schema.Class<AuditFinding>("AuditFinding")({
  engine: Schema.Literals(["effect-language-service", "eslint"]),
  file: Schema.String,
  rule: Schema.String,
  declaration: Schema.String,
  construct: Schema.String,
  occurrence: NonNegativeInt,
  severity: Schema.Literals(["error", "message"]),
  line: Schema.optionalKey(PositiveInt),
  excerpt: Schema.optionalKey(Schema.String)
}) {}

export class EffectAuditError extends Data.TaggedError("EffectAuditError")<{
  readonly reason:
    | "baseline-missing"
    | "baseline-growth"
    | "command-failed"
    | "invalid-output"
    | "new-findings"
    | "stale-baseline"
    | "coverage-gap"
    | "invalid-boundary"
  readonly findings: ReadonlyArray<AuditFinding>
  readonly detail?: string
}> {}
```

Reject empty or broad `file`, `declaration`, `host`, and `construct` strings in the registry validator rather than weakening their reusable schemas.

Architecture tests must compare tracked and untracked non-ignored TS-family files with `tsc --listFilesOnly`, compare tracked and untracked non-ignored TS/JS-family files with the actual filenames returned by whole-tree ESLint JSON, and reject broad, missing, duplicate, multi-match, and unconsumed permanent boundaries. Use `git ls-files --cached --others --exclude-standard -z` in tests so newly created test files participate before staging; the committed audit itself uses the index manifest.

- [ ] **Step 2: Verify the red state**

Run:

```bash
npm exec -- vitest run scripts/effect-audit.test.ts test/architecture/effect-boundary-coverage.test.ts test/architecture/effect-boundary-registry.test.ts
```

Expected: FAIL because the model, runner, validators, and baseline do not exist.

- [ ] **Step 3: Implement stable normalization and subset comparison**

Define the stable key exactly:

```ts
export const findingKey = (finding: AuditFinding): string =>
  [
    finding.engine,
    finding.file,
    finding.rule,
    finding.declaration,
    finding.construct,
    String(finding.occurrence)
  ].join("\u0000")

export const compareAudit = (
  baseline: ReadonlyArray<AuditFinding>,
  current: ReadonlyArray<AuditFinding>
): {
  readonly added: ReadonlyArray<AuditFinding>
  readonly removed: ReadonlyArray<AuditFinding>
} => {
  const expected = new Map(
    baseline.filter((finding) => finding.severity === "error")
      .map((finding) => [findingKey(finding), finding])
  )
  const actual = new Map(
    current.filter((finding) => finding.severity === "error")
      .map((finding) => [findingKey(finding), finding])
  )
  return {
    added: [...actual].filter(([key]) => !expected.has(key)).map(([, finding]) => finding),
    removed: [...expected].filter(([key]) => !actual.has(key)).map(([, finding]) => finding)
  }
}

export const canUpdateBaseline = (
  baseline: ReadonlyArray<AuditFinding>,
  current: ReadonlyArray<AuditFinding>
): boolean => compareAudit(baseline, current).added.length === 0

export const AuditBaselineJson = Schema.fromJsonString(Schema.Array(AuditFinding))
```

`line` and `excerpt` are display data only. Parse each language-service source with typescript-eslint using the audit project, translate its diagnostic position to an offset, and call `identityAtOffset` with that offset and fallback construct `diagnostic:${rule}` so both engines share declaration and occurrence rules. Sort by `findingKey`, deduplicate only duplicates from the same engine, exclude advisory messages from the blocking ledger, and report them separately. A committed baseline is valid only when every entry has severity `error`, keys are unique, and file order equals `findingKey` order.

- [ ] **Step 4: Implement the Effect-native audit runner and repository validator**

Implement these exact public seams in `scripts/effect-audit.ts`:

```ts
export interface AuditCommandRequest {
  readonly name: "language-service" | "eslint" | "typescript-files" | "tracked-files" | "tracked-modes"
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly acceptedExitCodes: ReadonlyArray<number>
}

export interface AuditCommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export class AuditCommandRunner extends Context.Service<AuditCommandRunner, {
  readonly run: (request: AuditCommandRequest) => Effect.Effect<AuditCommandResult, EffectAuditError>
}>()("expand/AuditCommandRunner") {}

export const runAudit = Effect.fn("effect-audit.run")(
  function* (options: { readonly root: string; readonly mode: "check" | "update" }) {
    const runner = yield* AuditCommandRunner
    return yield* collectAudit(runner, options)
  }
)
```

`collectAudit` is a private `Effect.fn` in the same file that uses `FileSystem`, `Path`, and Schema to normalize commands, validate coverage and permanent boundaries, read the baseline, compare it, and optionally write the strict subset. The live `AuditCommandRunner` layer captures the Effect `ChildProcessSpawner`, acquires each handle in `Effect.scoped`, and drains stdout, stderr, and exit status concurrently. The final CLI is `Command.make("effect-audit", { update: Flag.boolean("update") }, ...)`; derive the repository root with `Path.fromFileUrl(new URL("../", import.meta.url))`, provide the live runner and `NodeServices.layer`, and invoke only that program with `NodeRuntime.runMain`. Do not inspect `process.argv`.

Use the live runner to execute exactly:

```text
effect-language-service diagnostics --project tsconfig.effect-audit.json --format json --severity error,message
eslint --config eslint.effect.config.mjs . --format json
tsc --listFilesOnly -p tsconfig.effect-audit.json
git ls-files -z
git ls-files -s -z
```

The language-service and ESLint requests accept exit codes `0` and `1`; TypeScript and Git accept only `0`. Diagnostic exit `1` is valid only when stdout decodes. Interruption, platform failure, any unaccepted code, empty output where the format requires output, or malformed JSON is a typed audit failure. Require every indexed TS-family path to appear in the TypeScript file list and every indexed TS/JS-family path to appear in the ESLint result filenames inside `runAudit`, so the pre-commit command itself detects a new uncovered root. Normalize findings only for indexed first-party paths. Ignore extra untracked working-tree paths in the committed audit; the architecture tests compare tracked plus untracked sets during their own TDD cycle. Use Effect logging; do not import Node filesystem, path, child-process, console, date, timer, random, or environment APIs.

The permanent-boundary validator calls `analyzeEffectBoundaryProgram` for repository sources and proves each record resolves to one tracked file, one exact declaration, one exact construct occurrence, and one ESLint consumer. Add the audit program's single permanent boundary only after the analyzer verifies its identity:

```js
{
  file: "scripts/effect-audit.ts",
  declaration: "module:<module>",
  host: "Node audit entrypoint",
  construct: "runner:NodeRuntime.runMain",
  occurrence: 0
}
```

- [ ] **Step 5: Capture the initial ledger once, then remove initialization authority**

During implementation only, permit `--initialize` to write a missing baseline. Run:

```bash
git add scripts/effect-policy-model.ts scripts/effect-audit-model.ts scripts/effect-audit.ts scripts/effect-audit.test.ts test/architecture/effect-boundary-coverage.test.ts test/architecture/effect-boundary-registry.test.ts eslint-rules/effect-host-boundaries.mjs package.json
npm exec -- tsx scripts/effect-audit.ts --initialize
```

Staging the new source paths before capture makes the index-backed authoritative audit include its own implementation and tests. Remove the `--initialize` branch before commit. The committed `--update` path must fail if `effect-audit-baseline.json` is missing, fail on additions, and write only an identical set or strict subset. Add:

```json
{
  "effect:audit": "tsx scripts/effect-audit.ts",
  "effect:audit:update": "tsx scripts/effect-audit.ts --update"
}
```

- [ ] **Step 6: Verify the ratchet and exact validators**

Run:

```bash
npm run effect:audit
npm run effect:audit:update
npm exec -- vitest run scripts/effect-audit.test.ts test/architecture/effect-boundary-coverage.test.ts test/architecture/effect-boundary-registry.test.ts
npm run lint
npm run typecheck:effect-audit
```

Expected: all commands PASS; fake command output containing a synthetic added async function fails as new debt; deleting a baseline item fails as stale debt until the shrink-only update is run; deleting the baseline itself fails; and a fake clean file omitted from either semantic engine fails as `coverage-gap`.

- [ ] **Step 7: Commit**

```bash
git add scripts/effect-policy-model.ts scripts/effect-audit-model.ts scripts/effect-audit.ts scripts/effect-audit.test.ts effect-audit-baseline.json test/architecture/effect-boundary-coverage.test.ts test/architecture/effect-boundary-registry.test.ts eslint-rules/effect-host-boundaries.mjs package.json
git commit -m "build: ratchet Effect violations"
```

---

### Task 4: Inventory every grep candidate

**Files:**
- Create: `scripts/effect-inventory-model.ts`
- Create: `effect-grep-inventory.json`
- Create: `test/architecture/effect-audit.test.ts`
- Modify: `scripts/effect-audit.ts`
- Modify: `scripts/effect-audit.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `GrepCandidate` with one classification: `migration-debt`, `host-boundary`, `host-required-type`, `audit-fixture`, or `false-positive`.
- Produces: exact candidate comparison that fails on unclassified additions, moves, stale entries, or invalid classifications. Automatic updates remove debt but never add or reclassify it.
- Produces: the exact approved `npm run effect:grep` command.

- [ ] **Step 1: Write failing candidate-model and architecture tests**

Define this schema in `scripts/effect-inventory-model.ts`:

```ts
import { Schema } from "effect"
import { NonNegativeInt, PositiveInt } from "./effect-policy-model"

export class GrepCandidate extends Schema.Class<GrepCandidate>("GrepCandidate")({
  file: Schema.String,
  declaration: Schema.String,
  construct: Schema.String,
  occurrence: NonNegativeInt,
  classification: Schema.Literals([
    "migration-debt",
    "host-boundary",
    "host-required-type",
    "audit-fixture",
    "false-positive"
  ]),
  rationale: Schema.String,
  line: Schema.optionalKey(PositiveInt),
  excerpt: Schema.optionalKey(Schema.String)
}) {}

export const GrepInventoryJson = Schema.fromJsonString(Schema.Array(GrepCandidate))
```

Add model cases proving one record per declaration/construct/occurrence, stable ordering, duplicate rejection, strict-subset migration-debt updates, stale classification rejection, and classification immutability without an explicit reviewed edit. A manually added `host-boundary` candidate is valid only when it resolves to a permanent host-boundary record; `host-required-type`, `audit-fixture`, and `false-positive` require a non-empty rationale and an analyzer result consistent with that classification.

Create `test/architecture/effect-audit.test.ts` in its red state. Assert every current broad grep submatch has exactly one inventory record and every record resolves back to one current indexed source submatch.

- [ ] **Step 2: Verify the red state**

Run:

```bash
npm exec -- vitest run scripts/effect-audit.test.ts test/architecture/effect-audit.test.ts
```

Expected: FAIL because the candidate model, grep command, inventory, and audit integration do not exist.

- [ ] **Step 3: Add the exact requested grep command**

Add the command from the approved design unchanged, JSON-escaped in `package.json`:

```sh
rg -n --hidden \
  -g '*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}' \
  -g '!.git/**' \
  -g '!**/node_modules/**' \
  -g '!**/{dist,out,build,coverage,test-results,playwright-report}/**' \
  "\\basync\\b|\\bawait\\b|new\\s+Promise\\b|\\bPromise(?:Like)?\\s*<|\\bPromise\\.(?:all|allSettled|any|race|resolve|reject)\\b|\\.(?:then|catch|finally)\\s*\\(|\\b(?:setTimeout|setInterval|setImmediate|queueMicrotask|fetch)\\s*\\(|new\\s+(?:Date|WebSocket|Worker|MessageChannel|BroadcastChannel)\\s*\\(|\\b(?:console\\.\\w+|Date\\.now|performance\\.now|Math\\.random|crypto\\.randomUUID|JSON\\.(?:parse|stringify)|process\\.[A-Za-z_$][A-Za-z0-9_$]*|(?:window|document|navigator|localStorage|sessionStorage)\\.)|\\bnode:[^'\"[:space:]]+|\\b[A-Za-z_$][A-Za-z0-9_$]*\\.run(?:Promise(?:Exit)?|Sync(?:Exit)?|Fork|Callback|Main)\\b"
```

Run `npm run effect:grep`. Expected: exit 0 with current matches including representatives from apps, packages, scripts, tests, examples, benchmarks, and root configuration. Do not assert a fixed match or file count because Tasks 1–3 add audited sources before capture.

- [ ] **Step 4: Implement exact candidate validation**

Keep the human `effect:grep` command unchanged. Extend `AuditCommandRequest.name` with `grep-json` and have `runAudit` execute the same ripgrep expression and globs with `--json`; accept exits `0` and `1`, decode each match and submatch with Schema, retain only indexed first-party paths, and map positions through `analyzeEffectBoundaryProgram.identityAtOffset`. Ripgrep submatch offsets are UTF-8 byte offsets while ESTree ranges are UTF-16 code-unit offsets, so implement and test a pure `utf8ByteOffsetToCodeUnit` conversion, including an emoji before the match. When a lexical match has no blocking occurrence, use the nearest stable declaration plus `lexical:<matched-text>` and its same-declaration occurrence index.

Give every initial unmatched candidate the conservative `migration-debt` classification; promote only analyzer-proven host constructs, host-required types, audit fixtures, and lexical false positives. No update command may add new debt. A contributor may explicitly add a new non-debt record in a reviewed JSON edit, but normal audit accepts it only when the analyzer and permanent registries prove its classification.

- [ ] **Step 5: Capture the candidate inventory once, then remove initialization authority**

Temporarily add `--initialize-grep-inventory`, run:

```bash
git add scripts/effect-inventory-model.ts scripts/effect-audit.ts scripts/effect-audit.test.ts test/architecture/effect-audit.test.ts package.json
npm exec -- tsx scripts/effect-audit.ts --initialize-grep-inventory
```

Staging the new source paths before capture ensures they enter both semantic and grep inventories. Remove that flag before commit. Extend normal audit to require `effect-grep-inventory.json`, reject unclassified additions and stale records, validate every classification, and print candidate counts by classification. `effect:audit:update` may remove grep `migration-debt`; it may not create the file, add debt, reclassify entries, or rewrite non-debt records.

- [ ] **Step 6: Verify discovery and candidate coverage**

Run:

```bash
npm run effect:grep > /tmp/expand-effect-grep.txt
npm run effect:audit
npm exec -- vitest run scripts/effect-audit.test.ts test/architecture/effect-audit.test.ts
npm run lint
npm run typecheck:effect-audit
```

Expected: PASS; adding an unclassified grep match fails; an exact reviewed non-debt record passes only with analyzer evidence; deleting debt is stale until shrink update; deleting the inventory fails.

- [ ] **Step 7: Commit**

```bash
git add scripts/effect-inventory-model.ts scripts/effect-audit.ts scripts/effect-audit.test.ts effect-grep-inventory.json test/architecture/effect-audit.test.ts package.json
git commit -m "build: inventory Effect candidates"
```

---

### Task 5: Inventory every executable launcher

**Files:**
- Create: `effect-launchers.json`
- Modify: `scripts/effect-inventory-model.ts`
- Modify: `scripts/effect-audit.ts`
- Modify: `scripts/effect-audit.test.ts`
- Modify: `test/architecture/effect-audit.test.ts`

**Interfaces:**
- Produces: `ExecutableBoundary` with classification `host-launcher`, `host-fixture`, or `migration-debt` and an exact SHA-256 source fingerprint.
- Produces: exact launcher comparison that fails on new paths, stale paths, mode changes, source drift, or invalid classifications. Automatic updates remove launcher debt but never add or reclassify it.

- [ ] **Step 1: Write failing launcher-model and architecture tests**

Extend `scripts/effect-inventory-model.ts` with:

```ts
const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))

export class ExecutableBoundary extends Schema.Class<ExecutableBoundary>("ExecutableBoundary")({
  file: Schema.String,
  mode: Schema.String,
  sourceSha256: Sha256,
  classification: Schema.Literals(["host-launcher", "host-fixture", "migration-debt"]),
  host: Schema.String
}) {}

export const LauncherInventoryJson = Schema.fromJsonString(Schema.Array(ExecutableBoundary))
```

Add tests for lowercase 64-character digest validation, sorted unique paths, classification immutability, missing files, mode drift, source drift, and shrink-only debt removal. In `test/architecture/effect-audit.test.ts`, derive launcher paths from `git ls-files -s -z`: select every mode `100755` file and every tracked `.sh`, `.bash`, or `.zsh` file even without its executable bit. Assert that set is exactly the registry set and each digest equals current source bytes. The current set is `.githooks/pre-commit` and `scripts/binary-smoke.sh`; set equality is authoritative.

- [ ] **Step 2: Verify the red state**

Run:

```bash
npm exec -- vitest run scripts/effect-audit.test.ts test/architecture/effect-audit.test.ts
```

Expected: FAIL because the launcher schema, registry, fingerprinting, and audit integration do not exist.

- [ ] **Step 3: Implement exact launcher discovery and validation**

Seed `.githooks/pre-commit` as `host-launcher` and `scripts/binary-smoke.sh` as `migration-debt`, including modes and lowercase SHA-256 source digests. Read bytes with `FileSystem.readFile`, call `Crypto.digest("SHA-256", bytes)`, and encode with `Encoding.encodeHex`. Validate tracked paths, modes, selected shell extensions, non-empty host descriptions, classifications, and fingerprints. A `host-fixture` must be referenced by an exact test fixture declaration; a `host-launcher` must be an entry hook whose source contains only the commands needed to enter an Effect program or repository gate.

- [ ] **Step 4: Capture the launcher inventory once, then remove initialization authority**

Temporarily add `--initialize-launchers`, run:

```bash
git add scripts/effect-inventory-model.ts scripts/effect-audit.ts scripts/effect-audit.test.ts test/architecture/effect-audit.test.ts
npm exec -- tsx scripts/effect-audit.ts --initialize-launchers
```

Remove that flag before commit. Extend normal audit to require `effect-launchers.json` and reject path, mode, classification, and fingerprint drift. `effect:audit:update` may remove only launcher `migration-debt`; it may not create the file, add launchers, reclassify entries, or rewrite non-debt fingerprints. Explicit reviewed registry edits own legitimate non-debt changes.

- [ ] **Step 5: Verify launcher coverage and fingerprinting**

Run:

```bash
npm run effect:audit
npm exec -- vitest run scripts/effect-audit.test.ts test/architecture/effect-audit.test.ts
npm run lint
npm run typecheck:effect-audit
```

Expected: PASS; a synthetic new launcher, a mode change, and a one-byte source change each fail; deleting launcher debt is stale until shrink update; deleting the registry fails.

- [ ] **Step 6: Commit**

```bash
git add scripts/effect-inventory-model.ts scripts/effect-audit.ts scripts/effect-audit.test.ts effect-launchers.json test/architecture/effect-audit.test.ts
git commit -m "build: inventory Effect launchers"
```

---

### Task 6: Wire enforcement and publish the invariant

**Files:**
- Create: `docs/architecture/EFFECT_ONLY.md`
- Modify: `test/architecture/effect-audit.test.ts`
- Modify: `effect-launchers.json`
- Modify: `CODEOWNERS`
- Modify: `.githooks/pre-commit`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: one contributor command, `npm run effect:audit`, used locally, by the hook, and by CI.
- Produces: architecture ownership for policy, semantic configs, registries, and validators.
- Preserves: existing agent synchronization, lint, both normal typechecks, dependency-cruiser, Vitest, desktop E2E, and binary certification jobs.

- [ ] **Step 1: Extend the failing architecture test for enforcement wiring**

Assert that pre-commit runs `agents:check`, then `effect:audit`, then lint and typecheck; CI runs the same audit after install and before the existing static checks; CODEOWNERS protects the policy, audit configuration, registries, and architecture tests; and the policy document describes pure/effectful boundaries, approved adapters, update rules, and completion requirements.

- [ ] **Step 2: Verify the red state**

Run:

```bash
npm exec -- vitest run test/architecture/effect-audit.test.ts
```

Expected: FAIL because enforcement and policy ownership are absent.

- [ ] **Step 3: Wire the gate without dropping existing checks**

Remove the hook's stale explanatory comment block, retaining the shebang and `set -e`. Insert the exact label `echo "pre-commit › Effect boundary audit"` and `npm run effect:audit` after `npm run agents:check` in `.githooks/pre-commit`. Recompute only that reviewed `host-launcher` record's `sourceSha256` in `effect-launchers.json`; its path, mode, classification, and host remain unchanged. Add an `Effect-only boundary audit` step after dependency installation and before agent synchronization in the CI `checks` job. Keep the existing desktop E2E and binary-smoke jobs unchanged.

The final hook body is exactly:

```sh
#!/bin/sh
set -e

echo "pre-commit › agent definitions"
npm run agents:check

echo "pre-commit › Effect boundary audit"
npm run effect:audit

echo "pre-commit › eslint"
npm run lint

echo "pre-commit › typecheck"
npm run typecheck:all

echo "pre-commit › ok"
```

The new CI step is exactly:

```yaml
- name: Effect-only boundary audit
  run: npm run effect:audit
```

- [ ] **Step 4: Publish and protect the contributor policy**

Write `docs/architecture/EFFECT_ONLY.md` with these sections in order: `Effect-only boundary`, `Pure code stays pure`, `Required Effect shapes`, `Host adapters and launchers`, `Commands`, `Migration inventories`, `Changing an exception`, and `Completion`. Copy the approved design's definition and thirteen repository invariants without weakening them; include `npm run effect:grep`, `npm run effect:audit`, and the shrink-only update command; state that official diagnostics, the local semantic rule, registry validation, source coverage, grep classifications, and launcher fingerprints are cumulative; and require zero migration debt before deleting the temporary ledgers.

Append these exact ownership records, retaining the existing entries:

```text
/docs/architecture/EFFECT_ONLY.md  @g-imhoff
/tsconfig.effect-audit.json        @g-imhoff
/eslint.effect.config.mjs          @g-imhoff
/eslint-rules/effect-*             @g-imhoff
/scripts/effect-*                  @g-imhoff
/effect-*.json                     @g-imhoff
```

- [ ] **Step 5: Run the Stage 1 completion matrix**

Run:

```bash
npm run agents:check
npm run effect:audit
npm run effect:grep > /tmp/expand-effect-grep.txt
npm exec -- vitest run scripts/effect-audit.test.ts test/eslint/effect-boundary.test.mjs test/architecture/effect-language-service.test.ts test/architecture/effect-boundary-coverage.test.ts test/architecture/effect-boundary-registry.test.ts test/architecture/effect-audit.test.ts
npm run lint
npm run typecheck:effect-audit
npm run typecheck:all
npm run arch
npm run test
git status --short
```

Expected: every command PASS; normal audit rejects one synthetic new violation, one synthetic new launcher, and one synthetic grep candidate; the committed update path rejects missing inventories, new debt, and automatic non-debt edits.

- [ ] **Step 6: Commit**

```bash
git add docs/architecture/EFFECT_ONLY.md test/architecture/effect-audit.test.ts effect-launchers.json CODEOWNERS .githooks/pre-commit .github/workflows/ci.yml
git commit -m "build: enforce Effect-only policy"
```

---

## Plan completion evidence

The controller independently repeats the Task 6 matrix, checks that `git status --short` is clean, and inspects the committed baseline and inventories for exact stable keys. Stage 2 may begin only after every later change is guaranteed to remove or preserve measured debt without creating new debt.
