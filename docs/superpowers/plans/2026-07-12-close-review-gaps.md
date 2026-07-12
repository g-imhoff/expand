# Close Architectural Review Gaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the five confirmed agent-sync, state-root ownership, test-collection, and compiled auto-spawn certification gaps.

**Architecture:** Keep Claude definitions canonical and gate generated Codex mirrors everywhere. Treat an absolute normalized data directory as a state-root identity, enforce one server for that root with a lifetime lock, and document I-2/I-3 accordingly. Extend the existing fitness and smoke harnesses instead of introducing a new test framework or process manager.

**Tech Stack:** Bun, TypeScript 6, Effect v4 beta, Vitest, Bash, Electron/C4 documentation.

## Global Constraints

- Preserve the optional global `--data-dir` flag before and after subcommands.
- Distinct state roots may host independent backends; one state root may host at most one live `AppLayer`.
- Never signal or wait a numeric endpoint PID; numeric PIDs are identity evidence only.
- Process cleanup signals only stable Bash job specs and preserves state when ownership is uncertain.
- `.claude/agents/*.md` remains canonical; `.codex/agents/*.toml` remains generated.
- Do not add dependencies or code comments.
- Never run parallel tracked-tree writers.

---

### Task 1: Restore and enforce deterministic agent mirrors

**Files:**
- Modify: `scripts/sync-agents.test.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `.githooks/pre-commit`
- Generate: `.codex/agents/*.toml`

**Interfaces:**
- Consumes: `syncAgents({ rootDir, mode: "check" | "write" })`
- Produces: synchronized Codex mirrors and local/CI drift gates

- [ ] **Step 1: Add failing real-tree and gate-wiring tests**

Add `resolve` to the path imports and these cases to `scripts/sync-agents.test.ts`:

```ts
const repositoryRoot = resolve(import.meta.dir, "..")

it("keeps the committed Codex mirrors synchronized", async () => {
  await expect(syncAgents({ rootDir: repositoryRoot, mode: "check" })).resolves.toBeUndefined()
})

it("runs the synchronization gate before commits and in CI", () => {
  const hook = readFileSync(join(repositoryRoot, ".githooks", "pre-commit"), "utf8")
  const workflow = readFileSync(join(repositoryRoot, ".github", "workflows", "ci.yml"), "utf8")
  expect(hook).toContain("bun run agents:check")
  expect(workflow).toContain("run: bun run agents:check")
})
```

- [ ] **Step 2: Verify red**

Run `bun --bun vitest run scripts/sync-agents.test.ts`.

Expected: repository synchronization names the four stale TOML files and gate wiring is absent.

- [ ] **Step 3: Regenerate and wire gates**

Run `bun run agents:sync`. Add this CI step after dependency installation:

```yaml
- name: Agent definitions synchronized
  run: bun run agents:check
```

Add this pre-commit phase before lint and include it in the hook header:

```sh
echo "pre-commit › agent definitions"
bun run agents:check
```

- [ ] **Step 4: Verify green**

Run:

```bash
bun --bun vitest run scripts/sync-agents.test.ts
bun run agents:check
```

Expected: tests pass and the command prints `agent definitions are synchronized`.

- [ ] **Step 5: Commit**

```bash
git add .codex/agents scripts/sync-agents.test.ts .github/workflows/ci.yml .githooks/pre-commit
git commit -m "fix(agents): enforce synchronized definitions"
```

---

### Task 2: Enforce server ownership for a normalized state root

**Files:**
- Create: `apps/server/state-root-lock.ts`
- Create: `apps/server/test/integration/state-root-lock.test.ts`
- Modify: `apps/server/main.ts`
- Modify: `packages/contracts/app-context.ts`
- Modify: `packages/contracts/test/app-context.test.ts`

**Interfaces:**
- Produces: `StateRootLease`, `StateRootLockError`, `acquireStateRootLock(dataDir)`, `releaseStateRootLock(lease)`, and scoped `stateRootLock(dataDir)`
- Lifetime lock path: `<normalized-data-dir>/backend.lock`

- [ ] **Step 1: Add and run a failing normalization test**

Add:

```ts
it("normalizes a relative state root to one absolute identity", () => {
  expect(makeAppContext("relative-state").paths.dataDir).toBe(resolve("relative-state"))
})
```

Run `bun --bun vitest run packages/contracts/test/app-context.test.ts`.

Expected: FAIL because the relative value is currently preserved.

- [ ] **Step 2: Normalize in `makeAppContext`**

Import `resolve` from `node:path` and use:

```ts
const normalizeDataDir = (dataDir: string): string => resolve(dataDir)

export const makeAppContext = (dataDir?: string): AppContextShape => ({
  channel,
  paths: derivePaths(normalizeDataDir(dataDir ?? defaultDataDir()))
})
```

Re-run the contract test and expect PASS.

- [ ] **Step 3: Add and run failing lifetime-lock tests**

Create `state-root-lock.test.ts` covering:

```ts
it("rejects a second live owner for the same state root", async () => {
  const first = await Effect.runPromise(acquireStateRootLock(root))
  const second = await Effect.runPromise(Effect.result(acquireStateRootLock(root)))
  expect(second).toMatchObject({ _tag: "Failure", failure: { _tag: "StateRootLockError" } })
  await Effect.runPromise(releaseStateRootLock(first))
})

it("allows different state roots to coexist", async () => {
  const left = await Effect.runPromise(acquireStateRootLock(leftRoot))
  const right = await Effect.runPromise(acquireStateRootLock(rightRoot))
  await Effect.runPromise(Effect.all([releaseStateRootLock(left), releaseStateRootLock(right)]))
})

it("recovers a dead owner", async () => {
  writeFileSync(join(root, "backend.lock"), JSON.stringify({ pid: 2147483647, token: "dead" }))
  const lease = await Effect.runPromise(acquireStateRootLock(root))
  expect(lease.pid).toBe(process.pid)
  await Effect.runPromise(releaseStateRootLock(lease))
})

it("does not remove a replacement owner's lock", async () => {
  const lease = await Effect.runPromise(acquireStateRootLock(root))
  writeFileSync(lease.path, JSON.stringify({ pid: process.pid, token: "replacement" }))
  await Effect.runPromise(releaseStateRootLock(lease))
  expect(JSON.parse(readFileSync(lease.path, "utf8")).token).toBe("replacement")
})
```

Run the test and expect module-resolution failure because the lock module does not exist.

- [ ] **Step 4: Implement the lifetime lock**

Create `apps/server/state-root-lock.ts` with exclusive `wx` creation, owner JSON `{pid, token}`, `process.kill(pid, 0)` liveness, one stale-owner retry, mode `0600`, directory mode `0700`, and token-checked release. Use:

```ts
export interface StateRootLease {
  readonly path: string
  readonly pid: number
  readonly token: string
}

export class StateRootLockError extends Data.TaggedError("StateRootLockError")<{
  readonly dataDir: string
  readonly reason: string
}> {}

export const acquireStateRootLock = (
  dataDir: string
): Effect.Effect<StateRootLease, StateRootLockError>

export const releaseStateRootLock = (
  lease: StateRootLease
): Effect.Effect<void>

export const stateRootLock = (
  dataDir: string
): Effect.Effect<StateRootLease, StateRootLockError, Scope.Scope>
```

Release must reread `backend.lock` and remove it only when both PID and token match the lease.

- [ ] **Step 5: Wire lock ordering in `main.ts`**

Keep migration first so lock creation cannot suppress nested default-home migration. Acquire ownership before logger/database startup:

```ts
const program = Effect.gen(function* () {
  const { paths } = yield* AppContext
  yield* migrateDefaultHome(paths.dataDir)
  yield* stateRootLock(paths.dataDir)
  yield* loggedProgram
}).pipe(Effect.scoped)
```

- [ ] **Step 6: Verify and commit**

```bash
bun --bun vitest run packages/contracts/test/app-context.test.ts apps/server/test/integration/state-root-lock.test.ts apps/server/test/integration/migrate-default-home.test.ts
bun run typecheck:all
git add packages/contracts/app-context.ts packages/contracts/test/app-context.test.ts apps/server/state-root-lock.ts apps/server/test/integration/state-root-lock.test.ts apps/server/main.ts
git commit -m "fix(server): enforce state root ownership"
```

---

### Task 3: Pin state-root architecture and client convergence

**Files:**
- Create: `docs/architecture/decisions/2026-07-12-state-root-ownership.md`
- Modify: `docs/architecture/BOUNDARIES.md`
- Modify: `docs/architecture/expand.c4`
- Modify: `REVIEW.md`
- Modify: `packages/client-ts/ARCHITECTURE.md`
- Modify: `test/architecture/backend-ownership.test.ts`
- Modify: `packages/client-ts/test/integration/find-or-spawn.test.ts`

**Interfaces:**
- Consumes: normalized `AppContext` and `backend.lock` from Task 2
- Produces: one normative definition of state-root ownership

- [ ] **Step 1: Add and run failing architecture assertions**

Extend `backend-ownership.test.ts`:

```ts
expect(boundaries).toContain("## I-2. One AppLayer per state root")
expect(boundaries).toContain("## I-3. One discovery file per state root")
expect(model).toContain("One live backend per selected state root")
expect(model).toContain("backend.lock")
```

Run `bun --bun vitest run test/architecture/backend-ownership.test.ts`.

Expected: FAIL on machine-wide wording and absent lock model.

- [ ] **Step 2: Add client coordination characterization**

Add one same-root concurrent test whose adapter counts spawn calls and advertises one endpoint, plus a different-root test that provides separate `makeTestAppContext` layers and records both `dataDir` arguments.

Assertions:

```ts
expect(sameRootSpawnCount).toBe(1)
expect(new Set(spawnedRoots)).toEqual(new Set([leftRoot, rightRoot]))
```

Run the focused client test and record its pre-documentation behavior.

- [ ] **Step 3: Write the superseding ADR**

Document normalized absolute state-root identity, intentional multi-root operation, same-root singleton enforcement through `backend.lock`, client coordination through `server.json.lock`, per-root endpoint discovery, stale recovery, and I-4 scope.

- [ ] **Step 4: Update active docs and C4**

Use exact headings:

- `I-2. One AppLayer per state root`
- `I-3. One discovery file per state root`

Explain that I-1 confines construction statically while `backend.lock` enforces runtime uniqueness. Set the C4 backend description to `One live backend per selected state root; each owns that root's AppLayer and backend.lock.` Update the endpoint description, review invariant table, and client architecture spawn wording.

- [ ] **Step 5: Verify and commit**

```bash
bun --bun vitest run test/architecture/backend-ownership.test.ts packages/client-ts/test/integration/find-or-spawn.test.ts
git diff --check
git add docs/architecture REVIEW.md packages/client-ts/ARCHITECTURE.md test/architecture/backend-ownership.test.ts packages/client-ts/test/integration/find-or-spawn.test.ts
git commit -m "docs(architecture): define state root ownership"
```

---

### Task 4: Keep script placement and collection in lockstep

**Files:**
- Modify: `vitest.config.ts`
- Modify: `test/architecture/test-colocation.test.ts`

**Interfaces:**
- Produces: exported `testInclude` used by Vitest and its fitness test

- [ ] **Step 1: Add and run the failing assertion**

Import `testInclude` from `../../vitest.config` and add:

```ts
it("collects every approved direct script test extension", () => {
  expect(testInclude).toEqual(expect.arrayContaining([
    "scripts/**/*.test.ts",
    "scripts/**/*.test.tsx"
  ]))
})
```

Run `bun --bun vitest run test/architecture/test-colocation.test.ts`.

Expected: FAIL because `testInclude` is not exported and TSX is absent.

- [ ] **Step 2: Export one canonical include list**

In `vitest.config.ts`:

```ts
export const testInclude = [
  "apps/**/test/**/*.test.ts",
  "apps/**/test/**/*.test.tsx",
  "packages/**/test/**/*.test.ts",
  "packages/**/test/**/*.test.tsx",
  "test/architecture/**/*.test.ts",
  "scripts/**/*.test.ts",
  "scripts/**/*.test.tsx",
  "test/eslint/**/*.test.mjs",
  "examples/**/*.test.ts"
]
```

Set `test.include` to `testInclude`.

- [ ] **Step 3: Verify and commit**

```bash
bun --bun vitest run test/architecture/test-colocation.test.ts
bun run typecheck
git add vitest.config.ts test/architecture/test-colocation.test.ts
git commit -m "test: collect script tsx tests"
```

---

### Task 5: Certify compiled CLI sibling auto-spawn safely

**Files:**
- Modify: `scripts/binary-smoke.sh`
- Modify: `scripts/binary-smoke.test.ts`

**Interfaces:**
- Consumes: compiled `dist/expand` and sibling `dist/expand-server`
- Produces: `run_cli_autospawn(outputFile, args...)` with an owned guardian job/process group

- [ ] **Step 1: Add failing source-contract tests**

Require `set -m`, `unset EXPAND_BACKEND_CMD`, an auto-spawn call before directly-owned CRUD, guardian status/evidence/release files, endpoint-PID-to-owner-PGID validation, and removal of `server.json.lock` and `backend.lock`. Preserve prohibitions on process-name matching and numeric-PID signal/wait.

- [ ] **Step 2: Add failing shell-harness tests**

Use the existing extracted-function harness to prove:

```text
wrong endpoint PID process group -> unsafe, no numeric signal, data preserved
endpoint removed while PID remains in owned group -> guardian not released
verified backend departure -> release created and owned job reaped
cleanup timeout -> TERM then KILL only %job and preserve data
```

Run `bun --bun vitest run scripts/binary-smoke.test.ts` and expect failure because guardian helpers do not exist.

- [ ] **Step 3: Add guardian state**

Enable job control, require `ps`, clear inherited `EXPAND_BACKEND_CMD`, and create mode-0600 status/evidence/release paths below `DATA_DIR`. Track guardian PID/PGID separately from endpoint PID; keep `SERVER_JOB_SPEC` as the sole signal/wait authority.

- [ ] **Step 4: Implement `run_cli_autospawn`**

The guardian must:

1. start an endpoint monitor before the foreground CLI;
2. invoke `HOME="$SENTINEL_HOME" "${CLI[@]}" "$@"` without `start_server`;
3. atomically record endpoint PID and `ps -o pgid=` evidence;
4. atomically record CLI status;
5. wait for the controller release file; and
6. exit with the CLI status.

The controller captures the job spec immediately, requires the evidence PGID to equal the guardian PGID, validates the response, waits for endpoint and both locks to disappear, waits for the endpoint PID to leave the owned group, creates release, and reaps only the job spec.

- [ ] **Step 5: Preserve bounded failure cleanup**

Reuse TERM/KILL job-spec escalation. Malformed evidence, wrong group, timeout, remaining endpoint/lock, or unproven group departure sets `DATA_DIR_SAFE=0`. Cleanup preserves the directory and fails.

- [ ] **Step 6: Verify and commit**

```bash
bun --bun vitest run scripts/binary-smoke.test.ts
bun run cert:cli:build
git add scripts/binary-smoke.sh scripts/binary-smoke.test.ts
git commit -m "test(smoke): certify compiled auto spawn"
```

---

### Task 6: Final review and verification

- [ ] **Step 1: Run focused gates**

```bash
bun run agents:check
bun --bun vitest run scripts/sync-agents.test.ts packages/contracts/test/app-context.test.ts apps/server/test/integration/state-root-lock.test.ts test/architecture/backend-ownership.test.ts packages/client-ts/test/integration/find-or-spawn.test.ts test/architecture/test-colocation.test.ts scripts/binary-smoke.test.ts
```

- [ ] **Step 2: Run full verification**

```bash
bun run lint
bun run typecheck:all
bun run test
bun run cert:cli:build
git diff --check
git status --short --branch
```

- [ ] **Step 3: Request final branch review**

Give the reviewer the design, plan, full commit range, and exact verification output. Fix every Critical or Important finding in one consolidated TDD wave, repeat review, then rerun all verification commands.

