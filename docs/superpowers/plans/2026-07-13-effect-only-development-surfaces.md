# Effect-Only Development and Test Surfaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert every first-party test, fixture, Playwright helper, build/maintenance program, package workflow, example, benchmark, and binary certification harness to Effect while retaining only exact framework callbacks and irreducible POSIX job-control primitives.

**Architecture:** Effect Vitest supplies scoped test execution and test services. Shared process/filesystem fixtures return scoped Effects. Playwright has one exact Promise callback adapter whose test bodies return Effects. Repository and package scripts become NodeRuntime entry programs over FileSystem, ChildProcess, Crypto, Clock, Config, Schema, and Console. Examples and benchmarks expose Effect programs. Binary certification moves from shell orchestration to an Effect state machine with at most one minimal registered shell fixture.

**Tech Stack:** TypeScript 6.0.3, Effect and `@effect/vitest` 4.0.0-beta.74, `@effect/platform-node` beta 74, Vitest 4.1, Playwright 1.60, esbuild 0.27, Electron 42, LikeC4 1.56, Node.js 24.15, npm 11.

## Global Constraints

- Execute after `2026-07-13-effect-only-host-boundaries.md` is complete and committed.
- Pure total assertions and reducer/property tests may remain ordinary synchronous Vitest tests. Any I/O, time, randomness, process, Promise, recoverable parse, or resource lifetime belongs in `it.effect`, `it.live`, or a supplied Effect layer.
- Use the pinned `@effect/vitest@4.0.0-beta.74`; do not add a first-party Vitest Promise runner.
- Playwright receives exactly one local host adapter because its callback must return Promise. All Page, Locator, Electron, and assertion Promises are immediately wrapped with `Effect.tryPromise` inside test Effects.
- Test fixtures that start processes, open databases, create directories, install listeners, or allocate runtimes are scoped and close on assertion failure or interruption.
- Package manifest scripts invoke one first-party Effect entry program or one exact third-party tool. Remove command chains, `cd &&`, shell loops, and inline filesystem orchestration.
- Keep pure config modules pure. Register exact framework config callbacks only when their host requires platform access or Promise shape.
- Run `npm run effect:audit:update` after each task only after focused tests pass; no task may add migration debt.
- Do not add code comments.
- Every task is implemented by a fresh project `tdd-implementer`, then reviewed by a fresh project `task-reviewer`. Send all Critical and Important findings through one fresh fix wave and repeat the gate before continuing.
- Never dispatch parallel tracked-tree writers.

---

### Task 1: Establish Effect-native architecture and fixture helpers

**Files:**
- Create: `test/support/effect-process.ts`
- Create: `test/support/effect-files.ts`
- Create: `test/support/effect-process.test.ts`
- Modify: `test/architecture/backend-ownership.test.ts`
- Modify: `test/architecture/client-ts-barrel.test.ts`
- Modify: `test/architecture/depcruise-exclude.test.ts`
- Modify: `test/architecture/effect-version-lockstep.test.ts`
- Modify: `test/architecture/fold-version-lockstep.test.ts`
- Modify: `test/architecture/i1-cli-isolation.test.ts`
- Modify: `test/architecture/ipc-boundary.test.ts`
- Modify: `test/architecture/no-dead-code.test.ts`
- Modify: `test/architecture/node-only.test.ts`
- Modify: `test/architecture/node-package-manager.test.ts`
- Modify: `test/architecture/server-app-split.test.ts`
- Modify: `test/architecture/test-colocation.test.ts`
- Modify: `test/architecture/tui-input-boundary.test.ts`
- Modify: `test/architecture/effect-audit.test.ts`
- Modify: `test/architecture/effect-boundary-coverage.test.ts`
- Modify: `test/architecture/effect-boundary-registry.test.ts`
- Modify: `test/architecture/effect-language-service.test.ts`

**Interfaces:**
- Produces: `runCommand(command, args, options)` returning a typed Effect report with stdout, stderr, and exit code.
- Produces: `makeTempDirectoryScoped`/`writeFixture` helpers over Effect FileSystem and Path.
- Removes: direct synchronous Node filesystem/child-process/path access from architecture tests.

- [ ] **Step 1: Write failing helper lifecycle tests**

Use `it.live` from `@effect/vitest` and prove success output, nonzero exit, signal/interruption cleanup, concurrent stdout/stderr draining, temporary directory cleanup, and failure during fixture creation:

```ts
it.live("interrupts a scoped child and removes its temporary directory", () =>
  Effect.scoped(
    Effect.gen(function*() {
      const directory = yield* makeTempDirectoryScoped("expand-test-")
      const child = yield* startFixture(directory, hangingCommand)
      yield* Fiber.interrupt(child)
      return directory
    })
  ).pipe(
    Effect.flatMap((directory) => FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.exists(directory)))),
    Effect.tap((exists) => Effect.sync(() => expect(exists).toBe(false))),
    Effect.provide(NodeServices.layer)
  ))
```

- [ ] **Step 2: Verify the red state**

Run:

```bash
npm exec -- vitest run test/support/effect-process.test.ts
```

Expected: FAIL because shared Effect fixture helpers do not exist.

- [ ] **Step 3: Implement shared scoped helpers**

Use `ChildProcess.make`, scoped handles, Stream decoding, `Effect.all` for drains/status, FileSystem scoped temporary directories, Path, Schema, and tagged fixture errors. No helper returns Promise or exposes an unowned handle.

- [ ] **Step 4: Convert every architecture test**

Use ordinary `it` only for pure source-analysis fixtures. Use `it.live` plus NodeServices for Git, filesystem, dependency-cruiser, package-resolution, and generated-file checks. Replace try/catch around process execution with `Effect.exit` and assert typed reports. Preserve all existing architecture assertions exactly.

- [ ] **Step 5: Verify architecture coverage and audit**

Run:

```bash
npm exec -- vitest run test/support/effect-process.test.ts test/architecture
npm run arch
npm run effect:audit:update
npm run effect:audit
```

Expected: PASS; no architecture test directly imports Node filesystem or child-process modules.

- [ ] **Step 6: Commit**

```bash
git add test/support test/architecture effect-audit-baseline.json effect-grep-inventory.json
git commit -m "test: add Effect architecture fixtures"
```

---

### Task 2: Convert contracts, client, CLI, Electron IPC, and Ink tests

**Files:**
- Modify: `packages/contracts/test/app-context.test.ts`
- Modify: `packages/contracts/test/channel.test.ts`
- Modify: `packages/contracts/test/endpoint.test.ts`
- Modify: `packages/contracts/test/events.test.ts`
- Modify: `packages/contracts/test/project-fold.test.ts`
- Modify: `packages/contracts/test/project-schema.test.ts`
- Modify: `packages/contracts/test/project-sync.test.ts`
- Modify: `packages/contracts/test/rpc.test.ts`
- Modify: `packages/contracts/test/process-control.test.ts`
- Modify: `packages/client-ts/test/expand-client.test.ts`
- Modify: `packages/client-ts/test/fixtures/spawn-lock-contender.ts`
- Modify: `packages/client-ts/test/integration/acquire-client.test.ts`
- Modify: `packages/client-ts/test/integration/client-layer.test.ts`
- Modify: `packages/client-ts/test/integration/client-session.test.ts`
- Modify: `packages/client-ts/test/integration/discovery.test.ts`
- Modify: `packages/client-ts/test/integration/find-or-spawn.test.ts`
- Modify: `packages/client-ts/test/integration/node-adapter.test.ts`
- Modify: `packages/client-ts/test/integration/project-sync.test.ts`
- Modify: `packages/client-ts/test/integration/spawn-lock.test.ts`
- Modify: `packages/client-ts/test/unit/adapter-spawn-errors.test.ts`
- Modify: `packages/client-ts/test/unit/entrypoints.test.ts`
- Modify: `packages/client-ts/test/unit/resolve-backend-command.test.ts`
- Modify: `packages/client-ts/test/unit/supervise.test.ts`
- Modify: `apps/cli/test/harness.ts`
- Modify: `apps/cli/test/contract/contract.test.ts`
- Modify: `apps/cli/test/contract/envelope.test.ts`
- Modify: `apps/cli/test/unit/define-command.test.ts`
- Modify: `apps/cli/test/unit/envelope-schema.test.ts`
- Modify: `apps/cli/test/unit/errors.test.ts`
- Modify: `apps/cli/test/unit/global-flags.test.ts`
- Modify: `apps/cli/test/unit/resolve-target.test.ts`
- Modify: `packages/electron-ipc/test/bind-ipc.test.ts`
- Modify: `packages/electron-ipc/test/contract-types.test.ts`
- Modify: `packages/electron-ipc/test/contract.test.ts`
- Modify: `packages/electron-ipc/test/preload.test.ts`
- Modify: `packages/electron-ipc/test/renderer.test.ts`
- Modify: `packages/electron-ipc/test/validate-sender.test.ts`
- Modify: `packages/ink-input/test/bindings.test.ts`
- Modify: `packages/ink-input/test/hint-bar.test.tsx`
- Modify: `packages/ink-input/test/key-name.test.ts`
- Modify: `packages/ink-input/test/text-field.test.ts`
- Modify: `packages/ink-input/test/use-key-router.test.tsx`

**Interfaces:**
- Changes: all effectful test bodies to `it.effect`/`it.live` and all process fixtures to scoped Effects.
- Keeps: pure schema-shape, fold, binding, and type tests synchronous when they do not throw or touch the platform.
- Removes: first-party async helpers, Promise chains, direct Effect runners, native timers, and direct process/filesystem APIs from these suites.

- [ ] **Step 1: Add failing adapter and fixture assertions**

Add one contract test that a failed Effect reaches Vitest, one scoped client fixture assertion that interruption closes the process/socket/temp directory, and one test that TestClock replaces polling wall time. Use existing Stage 1 synthetic rule fixtures for host-runner enforcement.

- [ ] **Step 2: Convert contracts and pure tests**

Replace throwing Schema decoders used as test setup with Effect decoders in `it.effect` or non-throwing Result/Option decoders in pure tests. Convert ProjectSync and ProcessControl suites to Effect Vitest. Preserve property-test generators and deterministic folds as ordinary tests.

- [ ] **Step 3: Convert client and CLI process suites**

Move backend/server processes, sockets, temp dirs, TestClock, lock contenders, and CLI command invocation into shared scoped helpers. Replace every `Effect.runPromise`, `async`, `await`, `Promise.all`, and `.then/.catch/.finally` in this manifest. Fixture entrypoints end in one `NodeRuntime.runMain` boundary and expose no Promise API.

- [ ] **Step 4: Convert Electron IPC and Ink suites**

Use Effect Vitest for callback failure, Deferred, Clock, Crypto, Queue, MessagePort, and renderer lifecycle cases. Wrap Testing Library/Ink host Promises at the test boundary with `Effect.tryPromise`. Keep RuleTester-like pure input routing tests synchronous.

- [ ] **Step 5: Verify the complete manifest**

Run:

```bash
npm exec -- vitest run packages/contracts/test packages/client-ts/test apps/cli/test packages/electron-ipc/test packages/ink-input/test
npm run typecheck:all
npm run effect:audit:update
npm run effect:audit
```

Expected: PASS with no unapproved runner, Promise, ambient platform, or resource finding in these tests/fixtures.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/test packages/client-ts/test apps/cli/test packages/electron-ipc/test packages/ink-input/test effect-audit-baseline.json effect-grep-inventory.json
git commit -m "test: migrate package tests to Effect"
```

---

### Task 3: Convert the complete server test surface

**Files:**
- Modify: `apps/server/test/application/create-project.test.ts`
- Modify: `apps/server/test/application/rename-project.test.ts`
- Modify: `apps/server/test/fixtures/state-root-lock-contender.ts`
- Modify: `apps/server/test/integration/change-directory-e2e.test.ts`
- Modify: `apps/server/test/integration/concurrency.test.ts`
- Modify: `apps/server/test/integration/connect-during-shutdown.test.ts`
- Modify: `apps/server/test/integration/default-data-dir.test.ts`
- Modify: `apps/server/test/integration/delete-e2e.test.ts`
- Modify: `apps/server/test/integration/durability-restart.test.ts`
- Modify: `apps/server/test/integration/e2e-lifecycle.test.ts`
- Modify: `apps/server/test/integration/endpoint-file.test.ts`
- Modify: `apps/server/test/integration/event-bus.test.ts`
- Modify: `apps/server/test/integration/event-store.test.ts`
- Modify: `apps/server/test/integration/events-handler.test.ts`
- Modify: `apps/server/test/integration/events-replay.test.ts`
- Modify: `apps/server/test/integration/ops-lifecycle.test.ts`
- Modify: `apps/server/test/integration/project-event-store.test.ts`
- Modify: `apps/server/test/integration/projection-state-store.test.ts`
- Modify: `apps/server/test/integration/projection.test.ts`
- Modify: `apps/server/test/integration/replay-feed.test.ts`
- Modify: `apps/server/test/integration/set-metadata.test.ts`
- Modify: `apps/server/test/integration/snapshot-equivalence.test.ts`
- Modify: `apps/server/test/integration/sqlite-config.test.ts`
- Modify: `apps/server/test/integration/state-root-lock.test.ts`
- Modify: `apps/server/test/integration/trust-boundary.test.ts`
- Modify: `apps/server/test/integration/use-cases.test.ts`
- Modify: `apps/server/test/unit/access-log-redaction.test.ts`
- Modify: `apps/server/test/unit/connection-tracker.test.ts`
- Modify: `apps/server/test/unit/harness.test.ts`
- Modify: `apps/server/test/unit/ids.test.ts`
- Modify: `apps/server/test/unit/projects-fold.property.test.ts`
- Modify: `apps/server/test/unit/projects-fold.test.ts`
- Modify: `apps/server/test/unit/rpc-contract.test.ts`
- Modify: `apps/server/test/unit/rpc-guard.test.ts`

**Interfaces:**
- Produces: scoped server/database/WebSocket/temporary-state fixtures returning Effects.
- Uses: TestClock, deterministic Crypto, ConfigProvider, FileSystem, ProcessControl, and ChildProcess services.
- Preserves: serialized process-heavy state-root-lock certification and all lifecycle/durability assertions.

- [ ] **Step 1: Make the shared server harness Effect-only**

Extract repeated database, server, socket, endpoint, and state-root setup into scoped Effects. Add a forced assertion-failure test proving finalizers close SQLite, server, socket, process, and temporary directory.

- [ ] **Step 2: Convert application, unit, and storage tests**

Use `it.effect` for layers, SQL, event stores, projections, use cases, clocks, and crypto. Pure project folds/property tests remain synchronous. Replace wall-clock sleeps with TestClock unless a real subprocess/OS race is the behavior under test.

- [ ] **Step 3: Convert lifecycle, process, and WebSocket integration tests**

Use `it.live` and shared scoped helpers for real Node processes/sockets. Convert all async bodies, Promise concurrency, direct Node filesystem, timers, JSON parsing, and runners. Preserve real multi-process lock cases and serialize them through the existing Vitest project.

- [ ] **Step 4: Verify the full server suite**

Run:

```bash
npm exec -- vitest run apps/server/test
npm run typecheck:all
npm run effect:audit:update
npm run effect:audit
```

Expected: PASS with durability, lock, trust-boundary, shutdown, and cleanup behavior unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/server/test effect-audit-baseline.json effect-grep-inventory.json
git commit -m "test: migrate server tests to Effect"
```

---

### Task 4: Convert desktop and TUI unit, integration, and UI tests

**Files:**
- Modify: `apps/desktop/test/integration/connection-honesty.test.ts`
- Modify: `apps/desktop/test/integration/project-reconnect-sync.test.ts`
- Modify: `apps/desktop/test/integration/rpc-handlers.test.ts`
- Modify: `apps/desktop/test/integration/rpc-server.test.ts`
- Modify: `apps/desktop/test/integration/transport.test.ts`
- Modify: `apps/desktop/test/unit/backend-entry.test.ts`
- Modify: `apps/desktop/test/unit/command-hotkey.test.ts`
- Modify: `apps/desktop/test/unit/command-store.test.ts`
- Modify: `apps/desktop/test/unit/harden-web-contents.test.ts`
- Modify: `apps/desktop/test/unit/ipc-surface.test.ts`
- Modify: `apps/desktop/test/unit/origin-rules.test.ts`
- Modify: `apps/desktop/test/unit/port-lifecycle.test.ts`
- Modify: `apps/desktop/test/unit/project-context.test.tsx`
- Modify: `apps/desktop/test/unit/project-rpc.test.ts`
- Modify: `apps/desktop/test/unit/project-store.test.ts`
- Modify: `apps/desktop/test/unit/renderer-boot-port.test.ts`
- Modify: `apps/desktop/test/unit/renderer-feature-layout.test.ts`
- Modify: `apps/desktop/test/unit/renderer-port.test.ts`
- Modify: `apps/desktop/test/unit/renderer-sync-supervision.test.ts`
- Modify: `apps/desktop/test/unit/use-mutation-state.test.tsx`
- Modify: `apps/desktop/test/unit/window-options.test.ts`
- Modify: `apps/desktop/test/ui/_harness.tsx`
- Modify: `apps/desktop/test/ui/boot-error.test.tsx`
- Modify: `apps/desktop/test/ui/change-directory-dialog.test.tsx`
- Modify: `apps/desktop/test/ui/command-palette-restore.test.tsx`
- Modify: `apps/desktop/test/ui/delete-project-dialog.test.tsx`
- Modify: `apps/desktop/test/ui/edit-metadata-dialog.test.tsx`
- Modify: `apps/desktop/test/ui/projects-view-hides-archived.test.tsx`
- Modify: `apps/desktop/test/ui/rename-dialog.test.tsx`
- Modify: `apps/desktop/test/ui/setup.ts`
- Modify: `apps/tui/test/ui/_runtime-harness.ts`
- Modify: `apps/tui/test/ui/app-archive.test.tsx`
- Modify: `apps/tui/test/ui/app-delete.test.tsx`
- Modify: `apps/tui/test/ui/app-input-routing.test.tsx`
- Modify: `apps/tui/test/ui/app-mutation-error.test.tsx`
- Modify: `apps/tui/test/ui/confirm-delete.test.tsx`
- Modify: `apps/tui/test/ui/project-list.test.tsx`
- Modify: `apps/tui/test/ui/text-field.test.tsx`
- Modify: `apps/tui/test/ui/use-projects.test.tsx`
- Modify: `apps/tui/test/unit/bindings.test.ts`
- Modify: `apps/tui/test/unit/reduce.test.ts`
- Modify: `apps/tui/test/unit/route.test.ts`

**Interfaces:**
- Produces: Effect-valued Testing Library, renderer runtime, MessagePort, ManagedRuntime, and Ink harnesses.
- Guarantees: cleanup after assertion failure, unmount interruption, no post-unmount updates, and exactly-once runtime/port release.
- Keeps: pure reducers, key bindings, route selection, and Zustand state transitions as ordinary tests.

- [ ] **Step 1: Add failing cleanup tests to both UI harnesses**

Force a failed assertion after renderer/Ink setup and prove React roots, listeners, fibers, MessagePorts, and ManagedRuntime close. Add TestClock-controlled timeout and mutation interruption cases.

- [ ] **Step 2: Convert desktop integration and unit tests**

Use `it.effect`/`it.live`, Deferred, Queue, Fiber, Scope, and fake structural hosts. Wrap only Testing Library/Electron dependency Promises with `Effect.tryPromise`. Eliminate local `Effect.runPromise`, async helpers, and manual Promise barriers.

- [ ] **Step 3: Convert desktop UI and TUI suites**

Make harness render/unmount scoped. Convert waitFor/user-event/Ink host completion to Effect adapters. Keep synchronous DOM/React/Ink event dispatch as host callbacks. Use the production runner bridges rather than adding test-only runners.

- [ ] **Step 4: Verify UI and lifecycle suites**

Run:

```bash
npm exec -- vitest run apps/desktop/test apps/tui/test
npm run typecheck:desktop
npm run effect:audit:update
npm run effect:audit
```

Expected: PASS; no desktop/TUI test or harness exposes native Promise control flow or unowned resources.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/test apps/tui/test effect-audit-baseline.json effect-grep-inventory.json
git commit -m "test: migrate UI tests to Effect"
```

---

### Task 5: Add one Effect-aware Playwright adapter and migrate desktop E2E

**Files:**
- Create: `apps/desktop/e2e/effect-test.ts`
- Modify: `apps/desktop/e2e/helpers.ts`
- Modify: `apps/desktop/e2e/archive.spec.ts`
- Modify: `apps/desktop/e2e/change-directory.spec.ts`
- Modify: `apps/desktop/e2e/create.spec.ts`
- Modify: `apps/desktop/e2e/delete.spec.ts`
- Modify: `apps/desktop/e2e/rename.spec.ts`
- Modify: `apps/desktop/e2e/set-metadata.spec.ts`
- Modify: `apps/desktop/e2e/playwright.config.ts`
- Modify: `eslint-rules/effect-host-boundaries.mjs`

**Interfaces:**
- Produces: `testEffect(name, body)` as the only first-party Playwright callback returning Promise.
- Produces: scoped `launchApp` Effect that owns Electron, backend, CDP, listeners, and temp data.
- Preserves: serialized workers, timeouts, selectors, and all existing product flows.

- [ ] **Step 1: Write adapter rejection/interruption/cleanup tests**

Test the adapter model separately with a fake Playwright registration and prove Effect success, typed failure, defect, interruption, and scoped finalization all reach the host callback correctly.

- [ ] **Step 2: Implement the exact host adapter**

Use this boundary shape:

```ts
export const testEffect = (
  name: string,
  body: (fixtures: PlaywrightTestArgs) => Effect.Effect<
    void,
    unknown,
    Scope.Scope | NodeServices.NodeServices
  >
): void => test(name, (fixtures) =>
  Effect.runPromise(
    Effect.scoped(body(fixtures)).pipe(Effect.provide(NodeServices.layer))
  ))
```

Register only the nested Playwright callback and runner occurrence. No other E2E helper returns Promise.

- [ ] **Step 3: Make E2E helpers scoped Effects**

Wrap Electron/Locator/Page/expect dependency Promises with `Effect.tryPromise`. Use Effect FileSystem for temp directories, Schema for endpoint/payload decoding, Clock/Schedule for readiness, and acquireRelease for Electron/backend/CDP. Assertion failure must still close and remove everything.

- [ ] **Step 4: Convert all specs and verify**

Run:

```bash
npm run build:desktop
xvfb-run -a npm exec -- playwright test -c apps/desktop/e2e/playwright.config.ts
npm run typecheck:effect-audit
npm run effect:audit:update
npm run effect:audit
```

Expected: all E2E flows PASS and the only first-party E2E Promise signature is the registered adapter.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/e2e eslint-rules/effect-host-boundaries.mjs effect-audit-baseline.json effect-grep-inventory.json
git commit -m "test: run desktop E2E with Effect"
```

---

### Task 6: Convert build, fold-version, and agent-sync programs

**Files:**
- Delete: `scripts/build.mjs`
- Create: `scripts/build.ts`
- Modify: `scripts/fold-version.ts`
- Modify: `scripts/sync-agents.ts`
- Modify: `scripts/sync-agents.test.ts`
- Create: `scripts/build.test.ts`
- Modify: `test/architecture/fold-version-lockstep.test.ts`
- Modify: `package.json`
- Modify: `eslint-rules/effect-host-boundaries.mjs`

**Interfaces:**
- Produces: `buildBinaries`, `computeFoldHashes`, and `syncAgents` as named Effects.
- Produces: one NodeRuntime entry per script module.
- Uses: FileSystem, Path, Crypto, Stdio, Console, Schema, and ChildProcess/`Effect.tryPromise` for esbuild.

- [ ] **Step 1: Add failing filesystem/error/laziness tests**

Use no-op/fake services for build output and sync transactions. Prove esbuild rejection is tagged, fold-node absence is typed, generated content is deterministic, sync writes use temp-plus-rename, `--check` never mutates, and no operation runs at module import.

- [ ] **Step 2: Convert `scripts/build.ts`**

Use FileSystem for dist cleanup/directory/chmod and `Effect.tryPromise` for `esbuild.build`. Keep entry definitions and banner calculation pure. The `build` package script becomes `tsx scripts/build.ts`.

- [ ] **Step 3: Convert fold-version**

Keep TypeScript AST lookup/printer pure over supplied source. Read files through FileSystem, compute SHA-256 through Crypto.digest, encode generated source deterministically, and write through FileSystem. `computeFoldHashes` returns Effect and the lockstep test uses `it.effect`.

- [ ] **Step 4: Convert agent sync**

Keep frontmatter/roster/render logic pure and move YAML exceptions into a typed Effect adapter. Use FileSystem/Path for enumeration, reads, directories, writes, and rename. Define the `--check` interface with Effect CLI `Command`/`Flag`, log through Effect Console/Stdio, and invoke that command once through NodeRuntime.

- [ ] **Step 5: Verify scripts and audit**

Run:

```bash
npm exec -- vitest run scripts/build.test.ts scripts/sync-agents.test.ts test/architecture/fold-version-lockstep.test.ts
npm run agents:check
npm run gen:fold-version
npm run build
npm run effect:audit:update
npm run effect:audit
```

Expected: PASS; generated fold version is unchanged and all three scripts are Effect entry programs.

- [ ] **Step 6: Commit**

```bash
git add scripts/build.ts scripts/fold-version.ts scripts/sync-agents.ts scripts/build.test.ts scripts/sync-agents.test.ts test/architecture/fold-version-lockstep.test.ts package.json eslint-rules/effect-host-boundaries.mjs packages/contracts/fold-version.generated.ts effect-audit-baseline.json effect-grep-inventory.json
git rm scripts/build.mjs
git commit -m "refactor: run repository scripts with Effect"
```

---

### Task 7: Convert package, desktop, architecture-doc, and manifest orchestration

**Files:**
- Delete: `packages/contracts/scripts/prepare-publish.mjs`
- Delete: `packages/client-ts/scripts/prepare-publish.mjs`
- Create: `packages/contracts/scripts/prepare-publish.ts`
- Create: `packages/client-ts/scripts/prepare-publish.ts`
- Create: `packages/contracts/test/prepare-publish.test.ts`
- Create: `packages/client-ts/test/unit/prepare-publish.test.ts`
- Create: `scripts/desktop-command.ts`
- Create: `scripts/desktop-command.test.ts`
- Create: `docs/architecture/scripts/build.ts`
- Create: `docs/architecture/scripts/build.test.ts`
- Modify: `package.json`
- Modify: `packages/contracts/package.json`
- Modify: `packages/client-ts/package.json`
- Modify: `docs/architecture/package.json`
- Modify: `docs/architecture/package-lock.json`
- Modify: `eslint-rules/effect-host-boundaries.mjs`

**Interfaces:**
- Produces: package build/stage/pack Effects with Schema-validated package metadata.
- Produces: one desktop command program supporting `dev`, `build`, and `e2e` with explicit cwd.
- Produces: one architecture-doc build program owning cleanup, LikeC4/D2 child processes, and output enumeration.
- Removes: `&&`, `cd`, shell loops, `rm`, `mkdir`, and inline npm orchestration from all five manifests.

- [ ] **Step 1: Write failing staging and orchestration tests**

Test missing dist, malformed package JSON, exact export maps, recursive copy, cleanup, pack failure, desktop command cwd/args, D2 file enumeration, zero D2 files, one failed render, and interruption cleanup. Assert every manifest script is either one first-party entry or one exact third-party invocation.

- [ ] **Step 2: Convert both publish staging programs**

Use FileSystem, Path, Schema, Console, and ChildProcess. Each program accepts `--stage` or `--pack`; pack mode builds, stages, and packs sequentially inside one Effect. Update `build`, `stage:publish`, and `pack:tgz` scripts so none contains a command chain. Preserve exact public export maps and `private: false` staging.

- [ ] **Step 3: Convert root desktop orchestration**

`scripts/desktop-command.ts` parses `dev|build|e2e`, spawns Electron-Vite/Playwright with `cwd: apps/desktop`, inherits stdio, propagates signals, and maps nonzero exit to a tagged error. Point `dev:desktop`, `build:desktop`, and `e2e:desktop` at this single program. Replace `typecheck:all` command chaining with one direct audit-project typecheck or a single Effect command program while retaining separate root/desktop convenience scripts.

- [ ] **Step 4: Convert architecture-document build orchestration**

Pin `effect@4.0.0-beta.74`, `@effect/platform-node@4.0.0-beta.74`, `@effect/vitest@4.0.0-beta.74`, `vitest@4.1.7`, `tsx@4.21.0`, and `typescript@6.0.3` in the separate docs package. `docs/architecture/scripts/build.ts` owns clean, PNG export, D2 generation, D2 enumeration, parallel-or-bounded SVG rendering, and logging. Manifest scripts invoke the Effect program or exact LikeC4 dev server only.

- [ ] **Step 5: Verify all five manifests and package staging**

Run:

```bash
npm exec -- vitest run packages/contracts/test/prepare-publish.test.ts packages/client-ts/test/unit/prepare-publish.test.ts scripts/desktop-command.test.ts
npm --prefix docs/architecture exec -- vitest run scripts/build.test.ts
npm run build --workspace @expand/contracts
npm run stage:publish --workspace @expand/contracts
npm run build --workspace @expand/client-ts
npm run stage:publish --workspace @expand/client-ts
npm run build:desktop
npm run typecheck:all
npm run effect:audit:update
npm run effect:audit
```

Expected: PASS; all five manifests contain no inline first-party orchestration.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/scripts/prepare-publish.ts packages/client-ts/scripts/prepare-publish.ts packages/contracts/test/prepare-publish.test.ts packages/client-ts/test/unit/prepare-publish.test.ts scripts/desktop-command.ts scripts/desktop-command.test.ts docs/architecture/scripts docs/architecture/package.json docs/architecture/package-lock.json package.json packages/contracts/package.json packages/client-ts/package.json eslint-rules/effect-host-boundaries.mjs effect-audit-baseline.json effect-grep-inventory.json
git rm packages/contracts/scripts/prepare-publish.mjs packages/client-ts/scripts/prepare-publish.mjs
git commit -m "refactor: move manifest workflows to Effect"
```

---

### Task 8: Convert client examples and their smoke harness

**Files:**
- Modify: `examples/client-ts/adapter.ts`
- Modify: `examples/client-ts/archive-stale.ts`
- Modify: `examples/client-ts/audit-log.ts`
- Modify: `examples/client-ts/bootstrap-projects.ts`
- Modify: `examples/client-ts/test/helpers.ts`
- Modify: `examples/client-ts/test/archive-stale.smoke.test.ts`
- Modify: `examples/client-ts/test/audit-log.smoke.test.ts`
- Modify: `examples/client-ts/test/bootstrap-projects.smoke.test.ts`
- Modify: `eslint-rules/effect-host-boundaries.mjs`

**Interfaces:**
- Produces: named scoped Effect programs for all examples.
- Produces: scoped example server/process/temp-dir helper over ChildProcess, Deferred, FileSystem, and Clock.
- Leaves: one NodeRuntime runner in each executable example module.

- [ ] **Step 1: Add failing example cleanup and error-channel tests**

Prove invalid input and RPC failure stay typed, assertion failure closes backend/temp state, archive polling uses TestClock where possible, and each program is lazy until run.

- [ ] **Step 2: Convert example APIs and harness**

Replace async functions, Promise concurrency, direct runners, direct filesystem/process, native timers, and JSON parse/stringify. Use Schema codecs and Effect services. Keep presentation formatting pure. Each exported reusable operation uses `Effect.fn`; module entry uses NodeRuntime.

- [ ] **Step 3: Verify examples**

Run:

```bash
npm exec -- vitest run examples/client-ts/test
npm run typecheck:effect-audit
npm run effect:audit:update
npm run effect:audit
```

Expected: all example smoke tests PASS with no unowned process or first-party Promise.

- [ ] **Step 4: Commit**

```bash
git add examples/client-ts eslint-rules/effect-host-boundaries.mjs effect-audit-baseline.json effect-grep-inventory.json
git commit -m "refactor: run client examples with Effect"
```

---

### Task 9: Convert benchmark scenarios and reporting

**Files:**
- Modify: `bench/budgets.ts`
- Modify: `bench/main.ts`
- Modify: `bench/report.ts`
- Modify: `bench/rss.ts`
- Modify: `bench/seed.ts`
- Modify: `bench/selfcheck.ts`
- Modify: `bench/scenarios/cold-boot.ts`
- Modify: `bench/scenarios/rpc-replay.ts`
- Modify: `bench/scenarios/scan-drain.ts`
- Modify: `bench/scenarios/server-e2e.ts`
- Modify: `bench/scenarios/warm-boot.ts`
- Create: `bench/bench.test.ts`
- Modify: `package.json`
- Modify: `eslint-rules/effect-host-boundaries.mjs`

**Interfaces:**
- Changes: scenario functions from Promise-returning functions to Effects.
- Produces: scoped SQLite/server/RSS sampling resources and a narrow `BenchmarkHost` service for RSS and optional GC.
- Keeps: sample aggregation, budget comparison, and report rendering pure.
- Leaves: one NodeRuntime entry each in `bench/main.ts` and `bench/selfcheck.ts`.

- [ ] **Step 1: Add failing resource and deterministic report tests**

Cover SQLite close on failure, RSS sampler interruption, no native interval, deterministic Clock/DateTime metadata, absent GC, typed scenario failure, and stable report output.

- [ ] **Step 2: Convert resource and scenario APIs**

Use acquireRelease for SQLite/server/processes, FileSystem for seed files, Schedule/Clock fibers for RSS sampling, Schema for JSON, Console for output, and the injected benchmark host for ambient RSS/GC. Convert all scenarios to named Effects and preserve measured intervals.

- [ ] **Step 3: Convert entrypoints and verify benchmark smoke**

Run:

```bash
npm exec -- vitest run bench/bench.test.ts
npm run bench:selfcheck
npm run bench:events -- --smoke
npm run effect:audit:update
npm run effect:audit
```

Expected: PASS with scoped resources and no Promise-returning first-party benchmark API.

- [ ] **Step 4: Commit**

```bash
git add bench package.json eslint-rules/effect-host-boundaries.mjs effect-audit-baseline.json effect-grep-inventory.json
git commit -m "refactor: run benchmarks with Effect"
```

---

### Task 10: Replace binary-smoke shell orchestration with Effect

**Files:**
- Create: `scripts/binary-smoke-model.ts`
- Create: `scripts/binary-smoke.ts`
- Create: `scripts/fixtures/job-control.sh`
- Modify: `scripts/binary-smoke.test.ts`
- Delete: `scripts/binary-smoke.sh`
- Modify: `package.json`
- Modify: `effect-launchers.json`
- Modify: `eslint-rules/effect-host-boundaries.mjs`

**Interfaces:**
- Produces: Effect coordinator over build, children, filesystem evidence, endpoint/lock Schema, polling Schedule, signals, and cleanup.
- Produces: pure binary-certification state transitions in `binary-smoke-model.ts`.
- Changes: `cert:cli:build` to invoke only `tsx scripts/binary-smoke.ts`; the program itself performs the build.
- Produces: one source-hashed minimal POSIX shell fixture for the Bash job-table fact the certification exercises, never orchestration or policy.

- [ ] **Step 1: Extract failing pure state-machine tests**

Cover all current cases: ownership evidence, non-first job, readiness race, endpoint/PID/PGID replacement mismatch, malformed evidence/status, release/reap ordering, remaining files/processes, polling timeout, bounded cleanup, TERM-to-KILL escalation, and active-job cleanup.

- [ ] **Step 2: Add live failure/interruption cleanup tests**

Start disposable fixture processes, interrupt at each acquisition phase, and prove all children, process groups, temp directories, endpoint files, and locks are gone. Prove cleanup is bounded and KILL follows a failed TERM grace period.

- [ ] **Step 3: Implement the Effect coordinator**

Use FileSystem, Path, ChildProcess, Clock/Schedule, Config, Schema, ProcessControl, Deferred, and Scope. Track child/process-group evidence explicitly. Every child is acquired/released and all status/evidence parsing is typed. Run build as the first ChildProcess step. Use NodeRuntime only at module entry.

- [ ] **Step 4: Replace orchestration with the exact job-control fixture**

Delete `scripts/binary-smoke.sh`. Add `scripts/fixtures/job-control.sh` containing only job-control enable/start/capture/PGID/signal/wait primitives and no polling, filesystem policy, assertions, cleanup policy, or orchestration. The Effect coordinator invokes the fixture only for the Bash job-table assertion and owns every other state transition. Register the fixture as `host-fixture` with its exact source hash and remove the old launcher's migration-debt record.

- [ ] **Step 5: Run binary certification and Stage 4 closure**

Run:

```bash
npm exec -- vitest run scripts/binary-smoke.test.ts
npm run cert:cli:build
npm run effect:audit:update
npm run effect:audit
npm run effect:grep > /tmp/expand-effect-stage4-grep.txt
npm run lint
npm run typecheck:effect-audit
npm run typecheck:all
npm run arch
npm run knip
npm run test
npm run build:desktop
xvfb-run -a npm run e2e:desktop
git status --short
```

Expected: every command PASS; the semantic migration ledger is empty, every remaining grep entry is a host boundary, host-required type, audit fixture, or lexical false positive, and executable launcher inventory has no migration debt.

- [ ] **Step 6: Commit**

```bash
git add scripts/binary-smoke-model.ts scripts/binary-smoke.ts scripts/binary-smoke.test.ts scripts/fixtures/job-control.sh package.json effect-launchers.json eslint-rules/effect-host-boundaries.mjs effect-audit-baseline.json effect-grep-inventory.json
git rm scripts/binary-smoke.sh
git commit -m "refactor: certify binaries with Effect"
```

---

## Plan completion evidence

The controller independently repeats the Task 10 matrix and inspects all five manifests (`package.json`, `apps/desktop/package.json`, both publishable package manifests, and `docs/architecture/package.json`) for inline orchestration. Stage 5 begins only with an empty semantic baseline, no grep or executable migration-debt classification, and clean scoped process/resource evidence across tests, examples, benchmarks, and binary certification.
