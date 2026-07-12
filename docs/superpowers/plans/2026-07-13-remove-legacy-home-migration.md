# Remove Legacy Home Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove legacy-home relocation while preserving strict one-backend ownership for every independent data directory.

**Architecture:** Server startup will acquire `stateRootLockForStartup` directly from `main.ts` before creating logs, opening SQLite, or starting the RPC server. Migration modules, migration orchestration, migration-only coordination APIs, and their tests will be deleted; a new production-entrypoint regression test will prove that an old unscoped home is ignored while the channel default starts fresh.

**Tech Stack:** TypeScript 6, Bun 1.3, Effect 4 beta, Vitest 4.

## Global Constraints

- Every configured data directory, including the channel default, starts and remains an independent state root.
- Only one backend process may own a normalized state root at a time; different roots may run concurrently.
- The startup lock must be acquired before the logger, SQLite database, or RPC server touches the selected root.
- Do not migrate, copy, import, or delete existing user data.
- Do not change default data-directory names or client spawn-lock behavior.
- Do not add code comments.
- Preserve all unrelated worktree changes.

---

### Task 1: Remove migration and retain direct state-root ownership

**Files:**
- Create: `apps/server/test/integration/default-data-dir.test.ts`
- Modify: `apps/server/main.ts:5-41`
- Modify: `apps/server/state-root-lock.ts:15-132`
- Modify: `REVIEW.md:109-160,339`
- Delete: `apps/server/migrate-default-home.ts`
- Delete: `apps/server/migrate-legacy-home.ts`
- Delete: `apps/server/startup-ownership.ts`
- Delete: `apps/server/test/integration/migrate-default-home.test.ts`
- Delete: `apps/server/test/integration/migrate-legacy-home.test.ts`
- Delete: `apps/server/test/integration/startup-ownership.test.ts`
- Test: `apps/server/test/integration/default-data-dir.test.ts`
- Test: `apps/server/test/integration/state-root-lock.test.ts`

**Interfaces:**
- Consumes: `stateRootLockForStartup(dataDir: string, endpointFile: string): Effect.Effect<StateRootLease, StateRootLockError, Scope.Scope>` from `@expand/server/state-root-lock`.
- Produces: server startup that owns exactly one selected root without reading or relocating any other root.
- Preserves: `acquireStateRootLock`, `releaseStateRootLock`, `stateRootLock`, `stateRootLockForStartup`, `StateRootLease`, and `StateRootLockError`.
- Removes: `acquireOwnershipLock`, `acquireCoordinationLock`, `migrateDefaultHome`, `migrateLegacyHome`, and `startupOwnership`.

- [ ] **Step 1: Write the failing production-entrypoint isolation test**

Create `apps/server/test/integration/default-data-dir.test.ts` with this complete content:

```ts
import { describe, expect, it } from "vitest"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

const isRunning = (child: ReturnType<typeof spawn>) => child.exitCode === null && child.signalCode === null

const waitForExit = async (child: ReturnType<typeof spawn>, milliseconds: number) => {
  if (!isRunning(child)) return
  await Promise.race([once(child, "exit"), delay(milliseconds)])
}

describe("default data directory", () => {
  it("starts fresh without moving an old unscoped home", async () => {
    const root = mkdtempSync(join(tmpdir(), "expand-default-isolation-"))
    const legacyDir = join(root, ".expand")
    const defaultDir = join(legacyDir, "expand-dev")
    const endpointFile = join(defaultDir, "server.json")
    mkdirSync(legacyDir)
    writeFileSync(join(legacyDir, "events.db"), "")
    writeFileSync(join(legacyDir, "marker"), "legacy")

    const child = spawn(process.execPath, ["apps/server/main.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: root, EXPAND_LOG_LEVEL: "None" },
      stdio: ["ignore", "ignore", "pipe"]
    })
    let stderr = ""
    child.stderr?.setEncoding("utf8")
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk
    })

    try {
      const deadline = Date.now() + 10_000
      while (!existsSync(endpointFile) && isRunning(child) && Date.now() < deadline) {
        await delay(25)
      }
      if (!existsSync(endpointFile)) {
        throw new Error(
          `production server did not start: exit=${String(child.exitCode)} signal=${String(child.signalCode)} stderr=${stderr}`
        )
      }

      expect(existsSync(join(legacyDir, "events.db"))).toBe(true)
      expect(existsSync(join(legacyDir, "marker"))).toBe(true)
      expect(existsSync(join(defaultDir, "events.db"))).toBe(true)
      expect(existsSync(join(defaultDir, "marker"))).toBe(false)
    } finally {
      if (isRunning(child)) child.kill("SIGTERM")
      await waitForExit(child, 2_000)
      if (isRunning(child)) child.kill("SIGKILL")
      await waitForExit(child, 2_000)
      if (isRunning(child)) {
        child.stderr?.destroy()
        child.unref()
        throw new Error(`production server did not stop; data preserved at ${root}`)
      }
      rmSync(root, { recursive: true, force: true })
    }
  }, 15_000)
})
```

- [ ] **Step 2: Run the new test and verify the red state**

Run:

```bash
bun --bun vitest run apps/server/test/integration/default-data-dir.test.ts
```

Expected: FAIL after the server starts because the existing migration moved `events.db` and `marker` out of `legacyDir` and into `defaultDir`. The failure must be an assertion such as `expected false to be true`, not a timeout or process-start error.

- [ ] **Step 3: Acquire the state-root lock directly in the server entrypoint**

Apply this exact change to `apps/server/main.ts`:

```diff
 import { AppContext } from "@expand/contracts/app-context"
 import { runServer } from "@expand/server/composition/app"
-import { startupOwnership } from "@expand/server/startup-ownership"
+import { stateRootLockForStartup } from "@expand/server/state-root-lock"
@@
 const program = Effect.gen(function* () {
   const { paths } = yield* AppContext
-  yield* startupOwnership(paths)
+  yield* stateRootLockForStartup(paths.dataDir, paths.endpointFile)
   yield* loggedProgram
 }).pipe(Effect.scoped)
```

This keeps the lifetime lease inside the existing scope and before `loggedProgram` constructs the logger or opens the database.

- [ ] **Step 4: Remove migration-only coordination APIs from the lock module**

Apply these exact structural changes to `apps/server/state-root-lock.ts`:

```diff
-import { dirname, join, resolve } from "node:path"
+import { join, resolve } from "node:path"
```

Delete the complete exported `acquireOwnershipLock` and `acquireCoordinationLock` declarations:

```ts
export const acquireOwnershipLock = (
  lockPath: string
): Effect.Effect<StateRootLease, StateRootLockError> => {
  const normalizedPath = resolve(lockPath)
  const ownerDirectory = dirname(normalizedPath)
  return Effect.try({
    try: () => {
      secureDirectory(ownerDirectory)
      return acquireLease(normalizedPath, ownerDirectory)
    },
    catch: (error) => asStateRootLockError(ownerDirectory, error)
  })
}

export const acquireCoordinationLock = (
  lockPath: string
): Effect.Effect<StateRootLease, StateRootLockError> =>
  Effect.flatMap(
    Effect.sync(() => Date.now() + HANDOFF_TIMEOUT_MS),
    (deadline) => acquireCoordinationLockUntil(resolve(lockPath), deadline)
  )
```

Delete the complete private `acquireCoordinationLockUntil` declaration:

```ts
const acquireCoordinationLockUntil = (
  lockPath: string,
  deadline: number
): Effect.Effect<StateRootLease, StateRootLockError> =>
  Effect.suspend(() =>
    acquireOwnershipLock(lockPath).pipe(
      Effect.catch((error) => {
        if (error.kind !== "live-owner") return Effect.fail(error)
        if (Date.now() >= deadline) {
          return Effect.fail(new StateRootLockError({
            dataDir: dirname(lockPath),
            kind: "handoff-timeout",
            ...(error.ownerPid === undefined ? {} : { ownerPid: error.ownerPid }),
            reason: error.ownerPid === undefined
              ? "coordination lock handoff timed out"
              : `coordination lock handoff timed out waiting for process ${String(error.ownerPid)}`
          }))
        }
        return Effect.sleep(HANDOFF_RETRY_INTERVAL).pipe(
          Effect.andThen(acquireCoordinationLockUntil(lockPath, deadline))
        )
      })
    )
  )
```

Do not change the state-root lease acquisition, startup handoff, stale-owner recovery, or token/inode-safe release code.

- [ ] **Step 5: Delete migration implementation and obsolete tests**

Delete exactly these files:

```text
apps/server/migrate-default-home.ts
apps/server/migrate-legacy-home.ts
apps/server/startup-ownership.ts
apps/server/test/integration/migrate-default-home.test.ts
apps/server/test/integration/migrate-legacy-home.test.ts
apps/server/test/integration/startup-ownership.test.ts
```

Retain `apps/server/test/integration/state-root-lock.test.ts` and `apps/server/test/fixtures/state-root-lock-contender.ts` unchanged; they certify the ownership behavior that remains critical.

- [ ] **Step 6: Update the review guide to describe direct root ownership**

In `REVIEW.md`, remove the legacy-home migration entry and migration-safety bullet. Replace the state-root and entrypoint descriptions with:

```markdown
NEW (2026-07-13) 9. `state-root-lock.ts` — the hardened runtime ownership machinery. Raw root acquisition rejects a live owner immediately; startup gives an endpoint-absent owner the bounded four-second shutdown handoff. Dead-owner reclaim and release require unchanged PID/token/inode evidence, invalid or changing evidence fails closed, and distinct roots remain independent.
UPDATED (2026-07-13) 10. `composition/app.ts` → `main.ts` — lifecycle orchestration and the thin entrypoint. `main.ts` acquires the startup-aware scoped `backend.lock` lease before the file logger, database, or `AppLayer` is built. It sets `process.umask(0o077)` before anything touches the filesystem, while `app.ts` fail-closed-`chmod`s the data dir (`0700`), SQLite log (`0600`), and WAL/SHM sidecars if present (`secureIfPresent`).
```

Replace the ownership scrutiny bullet with:

```markdown
- **State-root ownership** (`state-root-lock.ts` + `main.ts`): I-1 confines construction statically, but `backend.lock` is the runtime singleton. Confirm an advertised live owner rejects promptly, an endpoint-absent live owner gets only a bounded startup/shutdown handoff with no overlapping lease, a stale endpoint without a live owner remains replaceable, distinct roots coexist, stale reclaim and release verify unchanged PID/token/inode evidence, malformed evidence fails closed without retry, and a stale finalizer cannot delete a replacement lease.
```

Remove migration tests from the best-tests paragraph. Keep `test/integration/state-root-lock.test.ts` as the first ownership test. Remove nested-migration-target claims from the client spawn-lock description while retaining the claims that same-root callers converge and distinct roots remain independent.

Replace fast-path item 3 with:

```markdown
3. **`contracts/app-context.ts` → CLI `main.ts` → client `spawn-lock.ts` → server `state-root-lock.ts` → `binary-smoke.sh`** — trace one explicit data directory end to end, including spawn convergence, path isolation, and runtime ownership (45–60 min).
```

- [ ] **Step 7: Verify the green state and retained ownership suite**

Run:

```bash
bun --bun vitest run apps/server/test/integration/default-data-dir.test.ts apps/server/test/integration/state-root-lock.test.ts
```

Expected: both files PASS. The default-data-dir test proves no relocation occurs; the state-root suite proves same-root exclusion, different-root coexistence, bounded handoff, stale recovery, and safe release.

- [ ] **Step 8: Confirm migration code and product-document references are gone**

Run:

```bash
rg -n "migrateDefaultHome|migrateLegacyHome|DefaultHomeMigrationError|MigrateDefaultHomeOptions|startupOwnership|acquireCoordinationLock|acquireOwnershipLock|legacy-migration\.lock|default-home migration|legacy home|nested migration" apps packages REVIEW.md
```

Expected: no output and exit status 1.

- [ ] **Step 9: Run repository verification**

Run each command independently:

```bash
bun run typecheck:all
bun run lint
bun run arch
bun run knip
bun run test
bun run cert:cli:build
```

Expected: every command exits 0 with no new warnings or failures. If an existing unrelated failure occurs, capture the exact command and output rather than modifying unrelated files.

- [ ] **Step 10: Commit the implementation**

Stage only the files listed in this task and commit:

```bash
git add REVIEW.md apps/server/main.ts apps/server/state-root-lock.ts apps/server/test/integration/default-data-dir.test.ts
git add -u apps/server/migrate-default-home.ts apps/server/migrate-legacy-home.ts apps/server/startup-ownership.ts apps/server/test/integration/migrate-default-home.test.ts apps/server/test/integration/migrate-legacy-home.test.ts apps/server/test/integration/startup-ownership.test.ts
git commit -m "refactor: remove legacy home migration"
```

Expected: the commit contains only migration removal, direct root-lock startup, the isolation regression test, and matching review-guide updates.

## Required Review Gates

After Task 1 is committed:

1. The controller dispatches a fresh project-scoped `task-reviewer` for spec compliance and code quality.
2. Any Critical or Important findings are adjudicated by the controller, sent as one consolidated wave to a fresh `tdd-implementer`, and reviewed again by a fresh `task-reviewer`.
3. The controller dispatches the project-scoped `code-reviewer` once across the complete branch.
4. The controller independently reruns the completion commands required by `superpowers:verification-before-completion` before reporting success.
