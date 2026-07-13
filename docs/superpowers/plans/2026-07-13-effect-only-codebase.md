# Effect-Only Codebase Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute the approved whole-repository Effect-only migration in dependency order without mistaking an intermediate ratchet for completion.

**Architecture:** Five implementation plans establish enforcement, migrate the functional core and host resources, convert development/test surfaces, then replace every migration artifact with permanent zero-debt certification. Each plan consumes the exact audit and inventory contracts produced before it. Reviews and runtime certification are staged gates, not deferred cleanup.

**Tech Stack:** TypeScript 6.0.3, Effect ecosystem 4.0.0-beta.74, `@effect/language-service` 0.86.6, ESLint 10, Vitest 4.1, Electron 42, Playwright 1.60, Node.js 24.15, npm 11.

## Global Constraints

- The approved source of truth is `docs/superpowers/specs/2026-07-13-effect-only-codebase-design.md`.
- Execute plans and tasks in the order below. A later plan may not weaken or bypass a prior gate.
- Pure total logic stays pure; effectful behavior uses Effect, Stream, Layer, or an Effect service.
- Permanent host exceptions are exact. Temporary semantic and grep inventories only shrink and are deleted/replaced at final ratchet.
- Do not add code comments.
- Every implementation/fix task uses a fresh project `tdd-implementer`; every wave uses a fresh project `task-reviewer`. Never dispatch parallel tracked-tree writers.
- The controller independently verifies task completion, owns review adjudication, invokes named runtime testers and the one whole-branch reviewer, and runs the final matrix through `superpowers:verification-before-completion`.

---

## Ordered plans

1. `docs/superpowers/plans/2026-07-13-effect-only-audit-foundation.md`
   - 6 tasks
   - Produces the official semantic project, local type-aware rule, exact permanent host registry, shrinking semantic ledger, broad grep command/inventory, executable registry, CI/hook enforcement, and policy document.

2. `docs/superpowers/plans/2026-07-13-effect-only-core-runtime.md`
   - 9 tasks
   - Consumes the Stage 1 ratchet.
   - Migrates AppContext, backend commands, process probes, IDs/time, both lock protocols, ProjectSync sinks, and named core operations.

3. `docs/superpowers/plans/2026-07-13-effect-only-host-boundaries.md`
   - 8 tasks
   - Consumes explicit core services and Effect-valued command/sink APIs.
   - Migrates Node spawn, Electron IPC, MessagePorts/RPC, Electron main/renderer, React mutations, and Ink/TUI lifecycle.

4. `docs/superpowers/plans/2026-07-13-effect-only-development-surfaces.md`
   - 10 tasks
   - Consumes production host runners and scoped resources.
   - Migrates tests, fixtures, Playwright, repository/package/doc scripts, examples, benchmarks, manifests, and binary certification.

5. `docs/superpowers/plans/2026-07-13-effect-only-final-certification.md`
   - 4 implementation tasks plus controller-owned runtime/review certification.
   - Replaces migration inventories, deletes the ledger/update mechanism, certifies packages, proves exact entrypoint/candidate/advisory coverage, runs named testers and React Doctor, performs one whole-branch review, and executes fresh final verification.

---

## Cross-plan gates

- [ ] **Gate 1:** Audit foundation passes with exact current debt, exact grep candidates, exact executable coverage, and no ability to add new debt.
- [ ] **Gate 2:** Core plan passes with explicit AppContext/ProcessControl, typed command/lock failures, injected Crypto/Clock, preserved lock atomicity, and named production Effects.
- [ ] **Gate 3:** Host plan passes with scoped child/port/listener/fiber/runtime ownership and only exact Electron/Playwright/entrypoint Promise or runner boundaries.
- [ ] **Gate 4:** Development plan passes with an empty semantic ledger, no grep/executable migration debt, Effect-native scripts/tests/examples/benchmarks, minimal or absent shell, and all five manifests free of inline orchestration.
- [ ] **Gate 5:** Final plan deletes all migration machinery, passes permanent zero-finding/candidate/entrypoint/package gates, named runtime testers, React Doctor, whole-branch review, and the controller's clean-checkout matrix.

## Execution protocol

For each numbered task in the active plan:

1. Controller dispatches one fresh `tdd-implementer` with the exact task text and relevant prior interfaces.
2. Implementer follows red-green-refactor, runs focused commands, updates only shrinking inventories when authorized, and commits the task.
3. Controller dispatches one fresh `task-reviewer` for spec compliance and code quality.
4. Controller consolidates Critical/Important findings into one fresh `tdd-implementer` fix wave, then repeats the same review gate.
5. Controller independently runs the task's completion commands before advancing.

The branch is complete only after Gate 5; an intermediate green audit backed by a nonempty ledger is explicitly incomplete.
