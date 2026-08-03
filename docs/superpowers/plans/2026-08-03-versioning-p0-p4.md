# Versioning P0–P4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver durable persistence migrations, one Git-derived product version, explicit compatibility ownership, deterministic version-policy checks, and a read-only Luna pull-request reviewer.

**Architecture:** Five ordered plans implement the approved design. Each plan produces one focused commit, passes a task-review gate, and becomes the base for the next plan. A final whole-branch review and verification gate covers the combined result.

**Tech Stack:** TypeScript, Effect 4, Effect SQL SQLite, Vitest, esbuild, electron-vite, GitHub Actions, `openai/codex-action@v1`.

## Global Constraints

- Product tags use `v<SemVer>`; the tag at the built commit is the sole release authority.
- CLI, server, desktop, `@expand/contracts`, and `@expand/client-ts` share one product release version.
- Compatibility epochs never derive from the product release version.
- Application runtime code never invokes Git.
- Database and event migrations fail closed and preserve existing data.
- Luna runs as `gpt-5.6-luna` with `effort: max`, `permission-profile: ":read-only"`, and `safety-strategy: drop-sudo`.
- The review job cannot write to the repository or pull request; a separate job owns the sticky comment.
- No automated npm publication, deployment, tag creation, or release-note generation is added.
- No code comments are added.
- Preserve unrelated worktree changes.

---

### Task 1: P0 — Persistence migrations and event upcasting

Plan: `docs/superpowers/plans/2026-08-03-versioning-p0-persistence.md`

Produces the database migration barrier, `event_revision` storage, the `ProjectCreated` 1→2 upcaster, and legacy replay coverage.

### Task 2: P1 — Git-derived product version

Plan: `docs/superpowers/plans/2026-08-03-versioning-p1-release-identity.md`

Produces the tag resolver, build metadata injection, CLI/server/desktop consumption, and fixed-group package staging.

### Task 3: P2 — Compatibility ownership and inventory

Plan: `docs/superpowers/plans/2026-08-03-versioning-p2-compatibility-ownership.md`

Removes the standalone CLI version module, gives the backend protocol a focused owner, and records every version domain.

### Task 4: P3 — Deterministic version policy

Plan: `docs/superpowers/plans/2026-08-03-versioning-p3-policy-enforcement.md`

Adds architecture enforcement for ownership, migration chains, release identity, package alignment, runtime Git exclusion, and documentation coverage.

### Task 5: P4 — Read-only Luna pull-request review

Plan: `docs/superpowers/plans/2026-08-03-versioning-p4-codex-review.md`

Adds the trusted read-only review job, strict structured output, stale-SHA protection, sticky findings, and deterministic AI repair prompts.

## Final branch gate

- [ ] Run a fresh whole-branch `code-reviewer` against the approved design and all five task reports.
- [ ] Send every Critical and Important finding through one fresh TDD fix wave, then repeat the affected review gate.
- [ ] Run `npm run effect:audit`.
- [ ] Run `npm run agents:check`.
- [ ] Run `npm run lint`.
- [ ] Run `npm run typecheck:all`.
- [ ] Run `npm run arch`.
- [ ] Run `npm run knip`.
- [ ] Run `npm run test`.
- [ ] Run `npm run cert:packages`.
- [ ] Run `npm run cert:cli:build`.
- [ ] Run `npm run bench:selfcheck`.
- [ ] Run `npm run bench:events -- --smoke`.
- [ ] Inspect the final diff and confirm that no unrelated user file changed.
