# P2 Compatibility Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove misleading version indirection while keeping each compatibility epoch with the contract it governs.

**Architecture:** The CLI envelope exports its own epoch from its existing owner module. A focused shared RPC module owns the bilateral backend protocol epoch. A central architecture document added in P2 inventories every release, compatibility, migration, cache, tooling, and dependency version domain without creating a global runtime counter.

**Tech Stack:** TypeScript, Effect Schema, Vitest, Markdown architecture documentation.

## Global Constraints

- Keep `expand/v1` unchanged.
- Keep backend protocol `2` unchanged.
- Keep the CLI envelope under `apps/cli`; it is not a shared RPC contract.
- Keep one production definition for each constant.
- Retain compatibility re-exports when they prevent a needless public import break.
- Tests keep hard-coded expected values as independent oracles.
- Do not move database migrations, event revisions, fold hashes, audit schema epochs, benchmark cache epochs, dependency pins, or build metadata into one module.
- No code comments are added.

---

### Task 1: Consolidate compatibility ownership and document every domain

**Files:**

- Delete: `apps/cli/cli/contract/version.ts`
- Modify: `apps/cli/cli/contract/envelope.ts`
- Modify: `apps/cli/cli/contract/project/envelope.ts`
- Modify: `apps/cli/cli/contract/server/envelope.ts`
- Modify: `apps/cli/cli/errors/envelope.ts`
- Modify: `apps/cli/test/contract/envelope.test.ts`
- Create: `packages/contracts/rpc/version.ts`
- Modify: `packages/contracts/endpoint.ts`
- Modify: every production and test import of `PROTOCOL_VERSION`
- Create: `docs/architecture/VERSIONING.md`

**Interfaces:**

- Produces: `ENVELOPE_VERSION` from `@expand/cli/contract/envelope`.
- Produces: `PROTOCOL_VERSION` from `@expand/contracts/rpc/version`.
- Preserves: `@expand/contracts/endpoint` re-exports `PROTOCOL_VERSION` for existing consumers.
- Produces: `VERSIONING.md`, the central discovery index; it has no runtime consumers.

- [ ] **Step 1: Move compatibility-oracle tests to the intended owners**

Change the CLI contract test import to:

```ts
import { ENVELOPE_VERSION } from "@expand/cli/contract/envelope"
```

Change the endpoint contract test to import the protocol epoch from:

```ts
import { PROTOCOL_VERSION } from "@expand/contracts/rpc/version"
```

Keep these assertions literal:

```ts
expect(ENVELOPE_VERSION).toBe("expand/v1")
expect(PROTOCOL_VERSION).toBe(2)
```

- [ ] **Step 2: Run the focused tests and confirm the red state**

```bash
npm exec -- vitest run apps/cli/test/contract/envelope.test.ts packages/contracts/test/endpoint.test.ts
```

Expected: FAIL because the new owner exports do not exist.

- [ ] **Step 3: Move the constants without changing their values**

Make `apps/cli/cli/contract/envelope.ts` begin with:

```ts
export const ENVELOPE_VERSION = "expand/v1" as const
```

Update every CLI envelope/error import, then delete `contract/version.ts`.

Create `packages/contracts/rpc/version.ts`:

```ts
export const PROTOCOL_VERSION = 2
```

Remove the definition from `endpoint.ts` and add:

```ts
export { PROTOCOL_VERSION } from "./rpc/version.js"
```

Update production imports in server composition and client discovery to use the focused module. Update tests to use the focused module unless the test specifically verifies the endpoint compatibility re-export.

- [ ] **Step 4: Write the complete central version inventory**

Create `docs/architecture/VERSIONING.md` with these sections and exact domain entries:

1. `Product release`: exact `v<SemVer>` tag, build-time resolver, all shipped artifacts, development fallback, and fixed-group packages.
2. `Tracked workspace manifests`: `0.0.0` development sentinels where tooling requires them; never a release source.
3. `CLI envelope`: `ENVELOPE_VERSION = "expand/v1"`, CLI-only consumer, breaking-output bump rule.
4. `Backend protocol`: `PROTOCOL_VERSION = 2`, server advertisement and client discovery, bilateral incompatibility bump rule.
5. `SQLite schema`: `effect_sql_migrations`, ordered server migrations, append-only migration rule.
6. `Stored events`: `EVENT_REVISIONS`, per-tag bumps, contiguous upcaster rule, future-version failure.
7. `Projection folds`: generated SHA-256 values, cache rebuild behavior, regeneration command.
8. `Audit inventories`: schema epoch `1`, owner scripts, independent bump rule.
9. `Benchmark seed cache`: generator epoch `1`, cache invalidation rule.
10. `Internal Effect commands`: development-only CLI metadata, independent from product release.
11. `Runtime and dependency pins`: Node, npm, Effect lockstep, documentation toolchain, and lockfile ownership.

For every section, include owner path, consumers, current value or generation rule, compatibility behavior, and one concrete example that does and does not require a bump.

- [ ] **Step 5: Run focused and boundary verification**

```bash
npm exec -- vitest run apps/cli/test/contract/envelope.test.ts packages/contracts/test/endpoint.test.ts packages/client-ts/test/integration/discovery.test.ts apps/server/test/integration/endpoint-file.test.ts
npm run typecheck:all
npm run arch
```

Expected: all commands PASS, and `rg -n 'contract/version' apps packages test` returns no matches.

- [ ] **Step 6: Commit P2**

```bash
git add apps/cli/cli/contract apps/cli/cli/errors/envelope.ts apps/cli/test/contract/envelope.test.ts packages/contracts/rpc/version.ts packages/contracts/endpoint.ts packages/contracts/test packages/client-ts apps/server docs/architecture/VERSIONING.md
git commit -m "refactor(versioning): clarify compatibility ownership"
```
