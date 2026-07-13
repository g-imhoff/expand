# Effect-Only Final Ratchet and Certification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete all migration-only acceptance machinery, prove zero unapproved Effect findings, validate every residual grep/advisory/entrypoint exactly, certify publish artifacts and runtime behavior, and finish with independent review plus fresh controller evidence.

**Architecture:** Package certification is an Effect program over scoped builds and tarballs. A final executable inventory proves a bijection among manifests, shebangs, executable bits, runners, Electron inputs, examples, benchmarks, and child fixtures. The audit stops comparing against a ledger and becomes a permanent zero-finding gate. A final candidate inventory links every residual broad grep submatch and language-service advisory to one exact reviewed reason. Named runtime testers and a whole-branch reviewer provide evidence beyond static checks.

**Tech Stack:** TypeScript 6.0.3, Effect 4.0.0-beta.74, `@effect/platform-node` beta 74, `@effect/language-service` 0.86.6, Vitest 4.1, Playwright 1.60, npm 11, Node.js 24.15, React Doctor.

## Global Constraints

- Begin only after Stages 1–4 and every task-review/fix loop are complete.
- `effect-audit-baseline.json` must decode to an empty array before this plan starts. A nonempty ledger is unfinished migration work, not an exemption.
- `effect-grep-inventory.json` and `effect-launchers.json` must contain no `migration-debt` record before they are replaced by final inventories.
- Every permanent host boundary must resolve to one tracked file, one declaration, one construct occurrence, and one consumer. No inline disable, glob, directory, or whole-file exemption may exist.
- Inspect all five manifests: root, desktop, both publishable workspaces, and `docs/architecture/package.json`.
- `scripts/fixtures/job-control.sh` is the sole source-hashed shell fixture and contains only the Bash job-table primitives retained by Stage 4.
- The final audit fails every error and warning. Every remaining `effectFnOpportunity` message is absent or exactly approved in the final advisory inventory; all other messages fail.
- Final inventories have no automatic accept-current/update command.
- Do not add code comments.
- Tasks 1–4 use a fresh project `tdd-implementer` and a fresh project `task-reviewer`; Critical and Important findings use one fresh fix wave and the repeated gate.
- Runtime testing, whole-branch review, review adjudication, React Doctor, and fresh final verification stay with the controller and the required named read-only/test agents.
- Never dispatch parallel tracked-tree writers.

---

### Task 1: Add Effect-native package and publish certification

**Files:**
- Create: `scripts/package-certification.ts`
- Create: `scripts/package-certification.test.ts`
- Create: `test/architecture/effect-certification.test.ts`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `eslint-rules/effect-host-boundaries.mjs`

**Interfaces:**
- Produces: `PackageCertificationError`, `PackageCertificationReport`, and `certifyPackages`.
- Produces: `npm run cert:packages` as one Effect entry program.
- Guarantees: package tarballs live only in scoped temporary storage and are removed after inspection.

- [ ] **Step 1: Write failing model and architecture tests**

Use these contracts:

```ts
export class PackageCertificationError extends Data.TaggedError("PackageCertificationError")<{
  readonly workspace: "@expand/contracts" | "@expand/client-ts"
  readonly phase: "build" | "stage" | "pack" | "inspect"
  readonly detail: string
  readonly cause?: unknown
}> {}

export interface PackageCertificationReport {
  readonly workspace: string
  readonly packageName: string
  readonly filename: string
  readonly files: ReadonlyArray<string>
  readonly exports: Readonly<Record<string, unknown>>
}
```

Test nonzero child exit, malformed npm JSON, leaked source/test/config file, missing export target, wrong private/files fields, interruption cleanup, and two valid synthetic packages. The architecture test requires `cert:packages` and explicit CI steps for audit, agents, lint, typechecks, architecture, Knip, Vitest, packages, benchmark smoke, binary certification, and desktop E2E.

- [ ] **Step 2: Verify the red state**

Run:

```bash
npm exec -- vitest run scripts/package-certification.test.ts test/architecture/effect-certification.test.ts
```

Expected: FAIL because certification and the expanded CI matrix are absent.

- [ ] **Step 3: Implement scoped package certification**

Implement `certifyPackages` with `Effect.fn("PackageCertification.run")`, FileSystem, Path, ChildProcess, Schema, and a scoped temporary directory. For each workspace run in order:

```text
npm run build --workspace <workspace>
npm run stage:publish --workspace <workspace>
npm pack <workspace>/dist-publish --json --pack-destination <scoped-temp-dir>
```

Decode npm JSON and staged/tarball package metadata. Require `private: false`, `files: ["dist"]`, existing export targets, and tar entries limited to `package.json` plus `dist/**`. Client exports are exactly `.`, `./project`, `./server`, `./adapters/node`, and `./package.json`. Contracts preserves the null `./events/domain-event` boundary and compiled wildcard exports. Import-smoke every public JavaScript target from the unpacked temporary artifact.

- [ ] **Step 4: Wire permanent CI coverage**

Add `"cert:packages": "tsx scripts/package-certification.ts"`. Expand the CI checks/build jobs without removing current desktop/binary certification. Register only the script's module-level `NodeRuntime.runMain` boundary.

- [ ] **Step 5: Verify and commit**

Run:

```bash
npm exec -- vitest run scripts/package-certification.test.ts test/architecture/effect-certification.test.ts
npm run cert:packages
npm run effect:audit
```

Expected: PASS with no tarball in the repository tree.

```bash
git add scripts/package-certification.ts scripts/package-certification.test.ts test/architecture/effect-certification.test.ts package.json .github/workflows/ci.yml eslint-rules/effect-host-boundaries.mjs
git commit -m "build: certify publish packages"
```

---

### Task 2: Replace the migration launcher registry with an exact executable inventory

**Files:**
- Create: `effect-executable-inventory.json`
- Create: `scripts/effect-executable-inventory.ts`
- Create: `scripts/effect-executable-inventory.test.ts`
- Create: `test/architecture/effect-executable-inventory.test.ts`
- Modify: `scripts/effect-audit.ts`
- Modify: `package.json`
- Delete: `effect-launchers.json`

**Interfaces:**
- Produces: a bijective `ExecutableInventory` covering all runtime entry sources and manifest invocations.
- Produces: `npm run effect:launchers`.
- Replaces: the migration-era executable launcher registry.

- [ ] **Step 1: Write failing discovery and identity tests**

Use this schema:

```ts
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))

export const ExecutableInventory = Schema.Struct({
  version: Schema.Literal(1),
  entrypoints: Schema.Array(Schema.Struct({
    file: Schema.String,
    declaration: Schema.Struct({ kind: Schema.String, name: Schema.String }),
    kind: Schema.Literals([
      "effect-entrypoint",
      "effect-free-transport-shim",
      "registered-host-launcher",
      "registered-host-fixture"
    ]),
    invokedBy: Schema.Array(Schema.Struct({ file: Schema.String, selector: Schema.String, occurrence: NonNegativeInt })),
    hostBoundary: Schema.optional(HostBoundaryLink),
    sourceHash: Schema.optional(Sha256)
  }))
})
```

Test tracked executable bits, shebang files, all five manifests, esbuild inputs, Electron main/preload/renderer inputs, module-level runners, examples, benchmarks, and child-process test fixtures. Reject globs, directories, untracked files, duplicates, missing/multiple declarations, stale manifest selectors, unlinked runners, and stale hashes.

- [ ] **Step 2: Verify the red state**

Run:

```bash
npm exec -- vitest run scripts/effect-executable-inventory.test.ts test/architecture/effect-executable-inventory.test.ts
```

Expected: FAIL because the final inventory and validator do not exist.

- [ ] **Step 3: Implement repository entrypoint discovery**

Use Git modes and file reads through Effect services. Prove a bijection with:

- tracked mode-100755 and shebang files;
- first-party source paths directly invoked by the five manifests;
- Electron build inputs;
- registered module runners;
- examples and benchmark entry programs;
- child-process-launched fixtures.

`registered-host-launcher` and `registered-host-fixture` records require exact SHA-256 source hashes. A host fixture must have one exact child-process invocation and contain only its registered primitive. `effect-free-transport-shim` is limited to the preload entry and may import neither Effect nor Node platform services. Include `scripts/fixtures/job-control.sh` as the sole host fixture retained by Stage 4.

- [ ] **Step 4: Populate the exact inventory and remove the migration registry**

Seed from the live discovered set after Stage 4, not a hardcoded count. Expected entries include the CLI/server/TUI/Electron entries, audit/build/fold/sync/binary/package scripts, both package staging entries, benchmark entries, example entries, lock-contender fixtures, preload shim, pre-commit hook, and `scripts/fixtures/job-control.sh`. Equality is authoritative.

Add `"effect:launchers": "vitest run test/architecture/effect-executable-inventory.test.ts"`. Make `effect:audit` call the same validation Effect. Delete `effect-launchers.json` and all migration model code for it.

- [ ] **Step 5: Verify and commit**

Run:

```bash
npm exec -- vitest run scripts/effect-executable-inventory.test.ts test/architecture/effect-executable-inventory.test.ts
npm run effect:launchers
npm run effect:audit
```

Expected: PASS; changing the hook or retained shell fixture fails by source hash.

```bash
git add effect-executable-inventory.json scripts/effect-executable-inventory.ts scripts/effect-executable-inventory.test.ts test/architecture/effect-executable-inventory.test.ts scripts/effect-audit.ts package.json
git rm effect-launchers.json
git commit -m "build: inventory executable boundaries"
```

---

### Task 3: Delete the migration ledger and enforce zero blocking findings

**Files:**
- Delete: `effect-audit-baseline.json`
- Modify: `scripts/effect-audit-model.ts`
- Modify: `scripts/effect-audit.ts`
- Modify: `scripts/effect-audit.test.ts`
- Modify: `test/architecture/effect-audit.test.ts`
- Create: `test/architecture/effect-final-ratchet.test.ts`
- Modify: `package.json`

**Interfaces:**
- Removes: `BaselineJson`, `compareAudit`, `canUpdateBaseline`, `--update`, and `effect:audit:update`.
- Changes: `npm run effect:audit` to fail immediately on any error or warning from either engine.
- Produces: a separate exact advisory collection for Task 4 validation.

- [ ] **Step 1: Write failing zero-ratchet tests**

Test zero findings, one language-service error, one ESLint error, one warning, one advisory message, malformed output, abnormal child exit, unknown CLI args, and absence of every migration API. The test's first Effect-native assertion reads and Schema-decodes the current baseline and requires an empty array before testing its removal. The final architecture test rejects baseline files, update scripts, inline disables, broad exemptions, and executable references to removed symbols.

- [ ] **Step 2: Verify precondition and red state**

Run:

```bash
npm run effect:audit
npm exec -- vitest run scripts/effect-audit.test.ts test/architecture/effect-audit.test.ts test/architecture/effect-final-ratchet.test.ts
```

Expected: precondition PASS; tests FAIL while baseline/update support remains.

- [ ] **Step 3: Remove ledger code and make the permanent runner strict**

The runner executes the dedicated language-service project once and whole-tree ESLint once, then host-boundary, source-coverage, and executable-inventory validation. Any error or warning fails. Messages are returned to the Task 4 advisory validator; unknown message names fail. Reject every CLI argument, including `--update`.

Remove `effect:audit:update` and every migration-only initializer/updater/model/error. Keep `"effect:audit": "tsx scripts/effect-audit.ts"` as one Effect entrypoint rather than a shell chain.

- [ ] **Step 4: Verify no migration mechanism survives**

Run:

```bash
npm exec -- vitest run scripts/effect-audit.test.ts test/architecture/effect-audit.test.ts test/architecture/effect-final-ratchet.test.ts
npm run effect:audit
if rg -n 'effect:audit:update|effect-audit-baseline|canUpdateBaseline|BaselineJson' package.json scripts test eslint-rules .github .githooks; then exit 1; fi
```

Expected: tests and audit PASS; ripgrep exits 1 with no executable/configuration match.

- [ ] **Step 5: Commit**

```bash
git add scripts/effect-audit-model.ts scripts/effect-audit.ts scripts/effect-audit.test.ts test/architecture/effect-audit.test.ts test/architecture/effect-final-ratchet.test.ts package.json
git rm effect-audit-baseline.json
git commit -m "build: require zero Effect findings"
```

---

### Task 4: Replace the migration grep inventory with exact final candidates and advisories

**Files:**
- Create: `effect-candidate-inventory.json`
- Create: `scripts/effect-candidate-inventory.ts`
- Create: `scripts/effect-candidate-inventory.test.ts`
- Create: `test/architecture/effect-candidate-inventory.test.ts`
- Modify: `scripts/effect-audit.ts`
- Modify: `package.json`
- Delete: `effect-grep-inventory.json`

**Interfaces:**
- Produces: exact `grep` and `advisories` collections with no line-number identity.
- Produces: `npm run effect:candidates` and makes the permanent audit call the same validator.
- Removes: migration-debt classifications and every automatic inventory updater.

- [ ] **Step 1: Write failing candidate/advisory validation tests**

Use this decoded model and implement the equivalent `Schema.Struct`/`Schema.Class` codecs plus `Schema.fromJsonString`; no cast or native JSON parser may load the inventory:

```ts
export interface CandidateInventory {
  readonly version: 1
  readonly grep: ReadonlyArray<{
    readonly file: string
    readonly declaration: { readonly kind: string; readonly name: string }
    readonly excerpt: string
    readonly match: string
    readonly occurrence: number
    readonly classification:
      | { readonly kind: "host-boundary"; readonly hostBoundary: string }
      | { readonly kind: "host-required-type"; readonly hostBoundary: string }
      | { readonly kind: "audit-fixture"; readonly expectedRule: string }
      | { readonly kind: "lexical-false-positive"; readonly reason: string }
  }>
  readonly advisories: ReadonlyArray<{
    readonly file: string
    readonly declaration: { readonly kind: string; readonly name: string }
    readonly rule: "effectFnOpportunity"
    readonly excerpt: string
    readonly occurrence: number
    readonly rationale: "small-expression" | "local-composition" | "host-callback"
  }>
}
```

Test new/stale/duplicate submatches, regex drift, line movement, duplicate excerpt occurrence, bad host link, executable false-positive misclassification, stale fixture rule, unknown advisory, and stale rationale.

- [ ] **Step 2: Collect exact grep JSON and official advisories**

Run the approved regex with `rg --json` through ChildProcess and normalize each submatch by file, declaration kind/name, trimmed excerpt, matched text, and same-excerpt occurrence. Assert the package script's roots/exclusions/pattern equal the collector constants.

Collect every language-service message. Any message other than `effectFnOpportunity` fails. An opportunity must be absent or have one exact rationale; messages are never silently ignored.

- [ ] **Step 3: Populate the inventory by review, without an accept-current command**

Classify every live submatch only after the validator itself exists so audit fixture strings and regex literals are included. `host-boundary` links to one consumed executable boundary. `host-required-type` links to a permanent Promise-signature boundary and resolves to a type position. `audit-fixture` resolves to one fixture/string declaration. `lexical-false-positive` must be confirmed by the AST analyzer as non-executable policy syntax.

Delete `effect-grep-inventory.json`, add `"effect:candidates": "vitest run test/architecture/effect-candidate-inventory.test.ts"`, and integrate the reusable validator into `effect:audit`. Do not add a generate/update package script.

- [ ] **Step 4: Verify and commit**

Run:

```bash
npm exec -- vitest run scripts/effect-candidate-inventory.test.ts test/architecture/effect-candidate-inventory.test.ts
npm run effect:grep > /tmp/expand-effect-final-grep.txt
npm run effect:candidates
npm run effect:audit
```

Expected: PASS; adding, moving, or deleting any candidate/advisory fails until an exact reviewed inventory edit is made.

```bash
git add effect-candidate-inventory.json scripts/effect-candidate-inventory.ts scripts/effect-candidate-inventory.test.ts test/architecture/effect-candidate-inventory.test.ts scripts/effect-audit.ts package.json
git rm effect-grep-inventory.json
git commit -m "build: validate final Effect candidates"
```

---

## Controller-owned runtime, review, and final verification

- [ ] Invoke the project `manual-tester` sequentially. Require compiled CLI/backend certification with 20/20 rows passing, including wrong-token rejection, backend reuse, last-client shutdown, and complete process/file cleanup.
- [ ] Invoke the project `desktop-tester` after manual certification. Require root/desktop builds and 9/9 exposed rows passing, with only `create-with-directory` recorded as `SKIP_NOT_EXPOSED`; require Electron/backend/CDP/temp cleanup.
- [ ] If either tester fails, use a fresh project `debugger` for reproduction/root cause, one fresh `tdd-implementer` fix wave, one fresh `task-reviewer`, then rerun the affected tester.
- [ ] Invoke the `react-doctor` skill for the changed React surface. Resolve every regression in a reviewed fix wave and require no score regression.
- [ ] Invoke one project `code-reviewer` across the complete branch with the approved design, commit list, diff stat, full contextual diff, and carried Minor findings. Consolidate all Critical and Important findings into one fresh `tdd-implementer` wave and one fresh `task-reviewer`; rerun any affected runtime tester.
- [ ] Invoke `superpowers:verification-before-completion`, then run from a clean checkout:

```bash
git status --short
npm ci
npm ci --prefix docs/architecture
npm run agents:check
npm run effect:audit
npm run effect:grep > /tmp/expand-effect-grep.txt
npm run effect:candidates
npm run effect:launchers
npm run lint
npm run typecheck:all
npm run arch
npm run knip
npm run test
npm run bench:selfcheck
npm run bench:events -- --smoke
npm run build
npm run cert:cli:build
npm run build:desktop
xvfb-run -a npm run e2e:desktop
npm run cert:packages
git diff --check
git status --short
```

Completion requires no baseline/update mechanism, zero errors/warnings, exact advisory/candidate/entrypoint coverage, valid packages without leaked tarballs, passing named tester verdicts, no unresolved Critical/Important review finding, React Doctor without regression, and a clean tree.
