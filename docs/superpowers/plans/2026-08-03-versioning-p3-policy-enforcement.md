# P3 Version Policy Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make version ownership, migration continuity, artifact identity, and documentation coverage fail deterministically in CI.

**Architecture:** One architecture test reads the narrow owner files and central inventory, imports pure registries/resolvers, and verifies cross-file invariants. Behavioral migration, staging, binary, and replay tests remain in their focused suites; this task connects them without duplicating their implementation details.

**Tech Stack:** TypeScript, Effect filesystem services, Effect Schema, Vitest, existing CI test orchestration.

## Global Constraints

- Assert semantic ownership and behavior, not formatting or broad source snapshots.
- Ordinary CI must pass without Git tags.
- Tests must not create, delete, or mutate repository tags.
- Compatibility-oracle tests retain literal `expand/v1` and `2` expectations.
- Architecture tests may repeat expected values; production code may not define duplicates.
- Existing Effect audit and fold-hash checks remain authoritative.
- No code comments are added.

---

### Task 1: Add the deterministic version-policy gate

**Files:**

- Create: `test/architecture/version-policy.test.ts`
- Modify: `docs/architecture/VERSIONING.md` only when the coverage test exposes a missing domain
- Modify: `test/architecture/manifest-orchestration.test.ts` only if the existing test explicitly inventories architecture test files or commands
- Modify: `.github/workflows/ci.yml` only if the new test is not already included by `npm run test`

**Interfaces:**

- Consumes: `resolveAppVersionObservation` from P1.
- Consumes: `EVENT_REVISIONS` and `EVENT_UPCASTERS` from P0.
- Consumes: `CURRENT_DATABASE_MIGRATION` and `DATABASE_MIGRATIONS` from P0.
- Consumes: `ENVELOPE_VERSION` and `PROTOCOL_VERSION` from P2.
- Produces: one Vitest suite named `version policy` that runs under the existing root test command.

- [ ] **Step 1: Write failing owner and compatibility tests**

Create `version-policy.test.ts` with `@effect/vitest` and `NodeServices.layer`. Read the repository root from `import.meta.url`. Add assertions equivalent to:

```ts
expect(ENVELOPE_VERSION).toBe("expand/v1")
expect(PROTOCOL_VERSION).toBe(2)
expect(EVENT_REVISIONS.ProjectCreated).toBe(2)
expect(CURRENT_DATABASE_MIGRATION).toBe(1)
```

Read tracked TypeScript files under `apps` and `packages` and count definitions matching `export const ENVELOPE_VERSION` and `export const PROTOCOL_VERSION`; require exactly one definition for each and require their approved owner paths. Exclude tests, generated files, and re-export statements from definition counts.

- [ ] **Step 2: Write failing chain and release-identity tests**

For every `[tag, currentRevision]` in `EVENT_REVISIONS`, assert that each integer from `1` through `currentRevision - 1` exists in `EVENT_UPCASTERS[tag]`. Parse the keys of `DATABASE_MIGRATIONS`; assert unique ascending ids ending at `CURRENT_DATABASE_MIGRATION`.

Exercise `resolveAppVersionObservation` with one exact tag, an untagged development commit, malformed tags, and conflicting tags. Read `scripts/build.ts`, `scripts/desktop-command.ts`, both package staging scripts, and the build-info module. Assert that:

- `__EXPAND_VERSION__` is the injected artifact symbol.
- Both binary entries receive one explicit function parameter rather than resolving independently.
- Package staging assigns the function argument, not `source.version`.
- Application source files do not contain `git describe`, `git tag`, `git rev-parse`, `node:child_process`, or `child_process`.

- [ ] **Step 3: Write failing manifest and documentation coverage tests**

Decode the root, desktop, contracts, client, and architecture-docs manifests with Effect Schema. Require any tracked private manifest version that remains to equal `0.0.0`. Require workspace dependency sentinels to stay aligned. Keep release expectations out of these source manifests.

Read `VERSIONING.md` and require one stable heading or table key for each domain:

```ts
const documentedDomains = [
  "Product release",
  "Tracked workspace manifests",
  "CLI envelope",
  "Backend protocol",
  "SQLite schema",
  "Stored events",
  "Projection folds",
  "Audit inventories",
  "Benchmark seed cache",
  "Internal Effect commands",
  "Runtime and dependency pins"
] as const
```

Assert every entry appears once and that the document contains `v<SemVer>` and `expand/v1`.

- [ ] **Step 4: Run the new test and confirm the red state**

```bash
npm exec -- vitest run test/architecture/version-policy.test.ts
```

Expected: FAIL for every missing export, metadata surface, or inventory entry exposed by the test.

- [ ] **Step 5: Close documentation gaps exposed by the policy test**

Add any missing `VERSIONING.md` entries found by the coverage test. Read migration ids and upcaster revisions directly from the runtime registries exported by P0; do not add parallel metadata lists. Do not weaken an invariant to match the implementation.

- [ ] **Step 6: Confirm CI orchestration includes the gate**

Run `npm run test -- --reporter=dot` and confirm Vitest discovers `test/architecture/version-policy.test.ts`. Leave `.github/workflows/ci.yml` unchanged when the existing `npm run test` step already covers it. If an explicit architecture-test allowlist exists, add only this file to that allowlist.

- [ ] **Step 7: Run deterministic policy verification**

```bash
npm exec -- vitest run test/architecture/version-policy.test.ts test/architecture/fold-version-lockstep.test.ts test/architecture/effect-version-lockstep.test.ts test/architecture/manifest-orchestration.test.ts
npm run test
npm run effect:audit
npm run typecheck:all
```

Expected: all commands PASS on an untagged checkout.

- [ ] **Step 8: Commit P3**

```bash
git add test/architecture/version-policy.test.ts docs/architecture/VERSIONING.md apps/server/migrations .github/workflows/ci.yml test/architecture/manifest-orchestration.test.ts
git commit -m "test(versioning): enforce release and compatibility policy"
```
