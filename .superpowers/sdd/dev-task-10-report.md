# Implementation report

Status: DONE_WITH_CONCERNS

## Changes
- scripts/binary-smoke-model.ts: added typed certification state, evidence, readiness, departure, release, reap, artifact, timeout, and TERM-to-KILL transitions.
- scripts/binary-smoke.ts: added the single Effect coordinator and NodeRuntime entry; build runs first, resources are scoped, payloads use Schema, polling uses Schedule, and compiled CRUD/auto-spawn certification is retained.
- scripts/fixtures/job-control.sh: added the minimal executable Bash job-table primitive fixture.
- scripts/binary-smoke.test.ts: replaced shell-source tests with 24 pure transition regressions and 4 live/scoped ownership regressions.
- scripts/binary-smoke.sh, scripts/cert-cli-build.ts, scripts/cert-cli-build.test.ts: removed stale shell and wrapper orchestration.
- package.json, effect-launchers.json, eslint-rules/effect-host-boundaries.mjs: registered the single TS entry and exact source-hashed host fixture.
- test/architecture/effect-audit.test.ts, test/architecture/manifest-orchestration.test.ts, test/architecture/server-app-split.test.ts, scripts/effect-audit.test.ts: replaced obsolete launcher assertions and synthetic registry fixtures.
- effect-audit-baseline.json, effect-grep-inventory.json: shrink-only updates after removing binary-smoke migration debt.

## Test or validation evidence
- Mode: TDD
- RED command: `npm exec -- vitest run scripts/binary-smoke.test.ts`; failed because `./binary-smoke-model` did not exist.
- GREEN command: `npm exec -- vitest run scripts/binary-smoke.test.ts test/architecture/server-app-split.test.ts test/architecture/manifest-orchestration.test.ts`; 3 files and 41 tests passed.
- Real certification: `npm run cert:cli:build`; exit 0.
- Audit idempotence: two consecutive `npm run effect:audit:update` runs produced byte-identical SHA-256 values; `npm run effect:audit` passed.
- Full suite: `npm run test`; exit 0.
- Static: lint, typecheck:all, arch, and knip passed.
- Desktop build passed. Desktop E2E failed in the pre-existing archive Playwright flow with `UnknownError: An error occurred in Effect.tryPromise`; Task 10 produced no Electron/renderer source changes and no Task 10 process survived.
- React Doctor: 83/100 with the existing one error and 45 warnings outside Task 10.

## Task gate
- Command: `npm exec -- vitest run scripts/binary-smoke.test.ts test/architecture/server-app-split.test.ts test/architecture/manifest-orchestration.test.ts`
- Result: 41 passed, exit 0.

## Commits
- c635e0c refactor: certify binaries with Effect

## Self-review
- Single TS entrypoint performs build first: satisfied.
- Pure state and all named ownership/race/cleanup transitions: satisfied.
- Scoped child/temp/file ownership and bounded TERM-to-KILL cleanup: satisfied by coordinator and live regressions.
- Minimal exact-hashed fixture and no launcher migration debt: satisfied; mode 100755 and SHA-256 f838640e89857f41b259118f581c4f8ab9c497c7256ae2e80509378f7f3d39e1.
- Package and architecture assertions: satisfied.
- No comments added and no unrelated tracked files changed: satisfied.
- No leaked Task 10 processes or temporary directories: satisfied.

## Concerns
- The base commit retains 30 semantic-ledger findings and 144 grep migration-debt candidates in unrelated files; Task 10 removed all binary-smoke debt but did not reclassify or widen scope into those files.
- Desktop E2E did not pass: the first archive test failed at the existing Effect.tryPromise Playwright adapter boundary.

# Fix wave

Status: NEEDS_CONTEXT

## Changes
- .superpowers/sdd/dev-task-10-report.md: recorded the missing-input blocker without changing production or test code.

## Test or validation evidence
- Mode: TDD
- RED command/result: not run because the complete reviewer findings and covering test files required to define the approved fix wave were not supplied.
- GREEN command/result: not run because implementation did not begin.

## Task gate
- Command: not run.
- Result: blocked before implementation.

## Commits
- None.

## Self-review
- Base commit `c635e0c` verified.
- Pre-existing untracked `.pi-subagents/` evidence preserved.
- Original Task 10 brief, implementation plan, implementation report, Task 10 diff, fix brief, and debugger evidence read.
- Complete Critical/Important/Minor reviewer findings: missing from the assignment and repository.
- Covering test files and rerun commands: missing from the assignment and repository.
- Production/test implementation: not started to avoid guessing about behavior and scope.

## Concerns
- The role contract requires the complete findings and covering test files for a fix wave. Repeated supervisor decision requests timed out without supplying them.

# Fix wave (consolidated Task 10 implementation)

Status: DONE_WITH_CONCERNS

## Changes
- scripts/binary-smoke-model.ts: retained active guardian ownership through KILL until verified cleanup and required the exact second Bash job.
- scripts/binary-smoke.ts: replaced the unrelated sleep fact with the real health CLI guardian, captured real CLI/job and endpoint PID/PGID evidence, drove readiness/departure/release/reap/status transitions from observations, retried only endpoint absence, added bounded TERM-to-KILL finalization, artifact/process verification, and combined primary/cleanup Cause retention.
- scripts/fixtures/job-control.sh: implemented the minimal fact/guardian/signal job-control protocol with exact started-PID/job-PID evidence, process-group signaling, cached status, and STOP/CONT release.
- scripts/binary-smoke.test.ts: added exact job, retained ownership, real guardian command, and combined Cause regressions; retained all required pure model cases and live fixture coverage.
- apps/desktop/e2e/helpers.ts: set repository-root Electron cwd at the E2E launch boundary with Effect Path and added post-close ownership-file waiting plus recursive temporary-state removal.
- apps/desktop/test/unit/playwright/effect-test.test.ts: added repository-root cwd and non-empty recursive cleanup regressions.
- apps/desktop/electron.vite.config.ts, eslint-rules/effect-host-boundaries.mjs, scripts/effect-audit.test.ts: removed the redundant prefixed builtin expansion, registered exact config/architecture host imports, and extended synthetic catalog proof.
- effect-audit-baseline.json, effect-grep-inventory.json, effect-launchers.json, scripts/effect-audit.ts: closed the semantic ledger to `[]`, classified every analyzer/fixture-proven grep identity with zero migration debt, kept classification proof narrow to audit infrastructure, and registered fixture mode/hash 100755/08efc26977082ed72b29359fa3da6a617de0efa287940ca730b6e00546f696d0.
- apps/cli/test/contract/contract.test.ts, apps/desktop/test/integration/rpc-handlers.test.ts, apps/server/test/integration/change-directory-e2e.test.ts, apps/server/test/integration/concurrency.test.ts, apps/server/test/integration/connect-during-shutdown.test.ts, apps/server/test/integration/delete-e2e.test.ts, apps/server/test/integration/durability-restart.test.ts, apps/server/test/integration/e2e-lifecycle.test.ts, apps/server/test/integration/events-replay.test.ts, apps/server/test/integration/ops-lifecycle.test.ts, apps/server/test/integration/set-metadata.test.ts, apps/server/test/integration/trust-boundary.test.ts, apps/server/test/unit/access-log-redaction.test.ts, packages/client-ts/test/integration/client-session.test.ts, packages/electron-ipc/test/validate-sender.test.ts: removed the 30 retained semantic findings without changing preserved comments.

## Test or validation evidence
- Mode: TDD
- RED: `npm exec -- vitest run scripts/binary-smoke.test.ts apps/desktop/test/unit/playwright/effect-test.test.ts`; exit 1 because Electron launch cwd was undefined and active ownership was cleared at KILL.
- GREEN: the same command; 2 files/36 tests passed, exit 0.
- RED: `npm exec -- vitest run scripts/binary-smoke.test.ts`; exit 1 because the second coordinator child was the synthetic sleep fact rather than the real health guardian.
- GREEN: `npm exec -- vitest run scripts/binary-smoke.test.ts`; 1 file/30 tests passed, exit 0.
- RED: combined-Cause regression first observed only the primary failure, then failed with `retainCleanupCause is not a function`; this proved ordinary finalizer composition discarded cleanup evidence.
- GREEN: the focused binary suite passed with both primary Fail and cleanup Die retained in one Cause.
- RED: successful six-flow E2E followed by the exact temp scan retained six non-empty `expand-e2e-home-*` directories because backend shutdown completed after Electron close.
- GREEN: `find ... -exec rm -rf ...; xvfb-run -a npm run e2e:desktop; find ... | wc -l`; six flows passed, exit 0, and remaining temp count was 0.
- Pre-closure evidence: base inventories contained 30 semantic findings, 144 grep migration-debt identities, and zero launcher debt.
- Post-closure evidence: audit reported 0 blocking findings; semantic baseline `[]`; grep candidates migration-debt=0, host-boundary=60, host-required-type=7, audit-fixture=116, false-positive=58; launchers migration-debt=0.
- Two final consecutive `npm run effect:audit:update` executions produced byte-identical hashes: baseline 4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945 and grep d289fd36e2e4192e20be7742379a042676e7175fb6ff0f7445d80115f2814921.
- `npm run effect:audit`; exit 0 with 0 blocking findings and zero migration debt.
- `npm run cert:cli:build`; exit 0; post-run process count 0 and `expand-binary-smoke-*` temp count 0.
- `xvfb-run -a npm run e2e:desktop`; 6/6 flows passed, exit 0; post-run `expand-e2e-home-*` temp count 0.
- `npm exec -- vitest run scripts/binary-smoke.test.ts apps/desktop/test/unit/playwright/effect-test.test.ts test/architecture/effect-audit.test.ts test/architecture/effect-boundary-registry.test.ts test/architecture/manifest-orchestration.test.ts test/architecture/server-app-split.test.ts`; 6 files/77 tests passed, exit 0.
- `npm run test`; 160 files passed, 1222 passed plus 1 expected failure (1223 total), exit 0.
- `npm run lint`; exit 0.
- `npm run typecheck:all`; exit 0.
- `npm run typecheck:effect-audit`; exit 0.
- `npm run typecheck:desktop`; exit 0.
- `npm run arch`; 189 modules/624 dependencies, no violations, exit 0.
- `npm run knip`; exit 0.
- `npm run build`; exit 0.
- `npm run build:desktop`; exit 0.
- `npm run build --workspace @expand/contracts`; exit 0.
- `npm run build --workspace @expand/client-ts`; exit 0.
- `npx react-doctor@latest --verbose --scope changed`; 83/100, one pre-existing renderer error and three pre-existing analyzer performance warnings, exit 1.
- `npm --prefix docs/architecture run build`; exit 1 because the environment lacks Playwright `chromium_headless_shell-1228`; LikeC4 explicitly requested `npx playwright install`. This build is outside the named Task 10 matrix and no external dependency installation was performed.
- Fixture proof: `stat` mode 755/100755; SHA-256 08efc26977082ed72b29359fa3da6a617de0efa287940ca730b6e00546f696d0; launcher inventory matches.
- Runner proof: package manifest contains exactly one `tsx scripts/binary-smoke.ts`; catalog/registry and architecture tests passed.
- Comment/whitespace proof: no existing comment line changed; `git diff --check` passed.

## Task gate
- Command: complete Task 10 matrix listed above, including focused model/live/adapter tests, real cert, E2E six flows, full tests, static gates, builds, audit idempotence, debt/identity/fixture/runner proofs, React Doctor, and leak scans.
- Result: all named Task 10 gates passed with exit 0; optional architecture-doc build was blocked only by its missing external browser artifact; React Doctor retained the baseline 83/100 and exits 1 when reporting existing findings.

## Commits
- Pending `fix: restore binary certification ownership`.

## Self-review
- Genuine sibling auto-spawn guardian owns the real health CLI/backend group: satisfied and certified live.
- Actual CLI job, endpoint PID/PGID, exact second job/PID correspondence, departure, release-before-reap, exactly-once cached status: satisfied.
- Readiness retries only transient absence; malformed, replacement, and exited evidence remain terminal typed failures: satisfied.
- Active ownership retained through KILL issuance until verified dead/artifact-free: satisfied.
- Bounded TERM grace, KILL escalation, survivor/artifact verification, and combined primary/cleanup Cause retention: satisfied.
- Repository-root cwd is limited to Electron E2E launch and uses Effect Path; product cwd unchanged: satisfied.
- Semantic baseline, grep debt, and launcher debt exactly zero with narrow proof-backed classifications and no hidden/escaped/token-split additions: satisfied.
- Fixture restricted to approved Bash job-control primitives and exact executable registration: satisfied.
- Existing comments preserved and no unrelated untracked orchestration artifact included: satisfied.

## Concerns
- The separate architecture-document build cannot run without the missing Playwright headless-shell download. All Task 10 named builds and gates pass.
- React Doctor intentionally reports the existing 83/100 baseline findings outside this fix wave.

# Fix wave completion audit correction

Status: DONE_WITH_CONCERNS

## Changes
- effect-grep-inventory.json: added exactly the 24 newly visible top-level registry metadata constants in `eslint-rules/effect-host-boundaries.mjs` as narrow `audit-fixture` records with exact string-syntax proof; no source spelling, policy, debt, or other classification was changed.
- All 28 previously dirty Task 10 files: preserved and completed the prior consolidated implementation.

## Test or validation evidence
- Mode: Declarative validation for the final inventory correction; retained TDD evidence above for executable behavior.
- Pre-edit validation: `npm run effect:audit:update`; exit 1 at the grep comparison with 24 additions and 0 implicit reclassifications, all from the honestly visible registry metadata constants.
- Intermediate correction check: `npm run effect:audit:update`; exit 1 with four remaining exact additions because the analyzer identity for the document/window literals is the matched token prefix (`document.`/`window.`), not the full metadata value. Those four records were corrected without changing source or policy.
- Post-edit audit update run 1: `npm run effect:audit:update`; exit 0; 0 blocking, 88 advisory, 265 grep candidates with migration-debt=0, host-boundary=60, host-required-type=7, audit-fixture=140, false-positive=58; launchers migration-debt=0. Baseline, grep inventory, and launcher hashes were unchanged across the run.
- Post-edit audit update run 2: `npm run effect:audit:update`; exit 0 with the same counts; hashes unchanged across the run. Therefore semantic additions and grep additions/reclassifications were `[]`, and both update runs were byte-idempotent.
- Audit check: `npm run effect:audit`; exit 0 with the same counts. `jq -c . effect-audit-baseline.json` returned `[]`; grep and launcher migration-debt queries each returned `[]`.
- Diff check: `git diff --check`; exit 0.
- Focused covering gate: `npm exec -- vitest run scripts/binary-smoke.test.ts apps/desktop/test/unit/playwright/effect-test.test.ts test/architecture/effect-audit.test.ts test/architecture/effect-boundary-registry.test.ts test/architecture/manifest-orchestration.test.ts test/architecture/server-app-split.test.ts`; 6 files/77 tests passed, exit 0.
- Real certification with leak scan: remove `expand-binary-smoke-*`; scan Task 10 processes; `npm run cert:cli:build`; rescan processes/temp state; exit 0, pre/post process count 0 and temp count 0.
- Desktop E2E with leak scan: remove `expand-e2e-home-*`; scan Task 10 Electron/backend processes; `xvfb-run -a npm run e2e:desktop`; rescan processes/temp state; all 6 flows passed, exit 0, pre/post Task 10 process count 0 and temp count 0. A first broader scan also observed only the pre-existing Codex Desktop Electron process set before and after, then the task-specific scan passed.
- Full suite: `npm run test`; 160 files passed, 1222 passed plus 1 expected failure (1223 total), exit 0.
- Static gates: `npm run lint`, `npm run typecheck:all`, `npm run typecheck:effect-audit`, `npm run typecheck:desktop`, and `npm run knip`; each exit 0. `npm run arch`; 189 modules/624 dependencies, no violations, exit 0.
- Builds: `npm run build`, `npm run build:desktop`, `npm run build --workspace @expand/contracts`, and `npm run build --workspace @expand/client-ts`; each exit 0.
- React Doctor: `npx react-doctor@latest --verbose --scope changed`; 83/100, one existing renderer error and three existing analyzer performance warnings, exit 1 without regression.
- Environment residual: `npm --prefix docs/architecture run build`; exit 1 only because `/home/gimhoff/.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell` is absent. This is not a Task 10 gate.
- Fixture proof: `stat`, `git ls-files -s`, `sha256sum`, and launcher query showed mode 755/100755 and SHA-256 `08efc26977082ed72b29359fa3da6a617de0efa287940ca730b6e00546f696d0`; inventory matches. Package runner query returned exactly one `tsx scripts/binary-smoke.ts`.
- Dirty-set proof: `git diff --name-only | wc -l` returned 28. Only `.pi-subagents/` remained untracked and was excluded.

## Task gate
- Command: complete Task 10 matrix listed immediately above.
- Result: every required Task 10 gate passed; focused gate 6 files/77 tests, full suite 160 files/1223 tests with one expected failure, certification and 6-flow E2E leak-free, audit twice idempotent with semantic baseline `[]` and debt 0.

## Commits
- 600c4ef fix: restore binary certification ownership

## Self-review
- Required correction is exactly 24 narrow registry-constant `audit-fixture` records: satisfied; all 24 have `variable:*` declarations, exact lexical constructs/locations, occurrence 0, and fixture-syntax rationale.
- No string hiding/re-splitting, debt, policy broadening, other addition, or reclassification: satisfied; only `effect-grep-inventory.json` changed during the completion correction and audit passed twice idempotently.
- Prior full consolidated fix preserved across exactly 28 intended tracked files: satisfied.
- Covering tests named and rerun: satisfied for all six supplied files.
- Staging and commit: satisfied; staged set matched the intended 28-file set exactly, cached diff check passed, and one exact-message commit was created.

## Concerns
- Architecture-document build lacks the external Playwright Chromium artifact and is explicitly outside the Task 10 gate.
- React Doctor retains the pre-existing 83/100 diagnostics and therefore exits 1.

# Fix wave (Task 10 process-group termination)

Status: DONE_WITH_CONCERNS

## Changes
- scripts/binary-smoke.ts: captures and validates initial guardian job/PID/PGID evidence from the live stdout stream before endpoint acquisition; uses the fixture signal primitive against the exact owned PGID; verifies TERM departure, escalates to KILL after a bounded wait, rejects KILL survivors, releases and reaps the guardian once, verifies artifacts, handles pre-evidence guardian cleanup, and retains cleanup Cause with a primary Cause.
- scripts/binary-smoke.test.ts: replaces the unused Layer/release-counter test with deterministic production cleanup-path cases for pre-evidence cleanup, TERM success, TERM-to-KILL escalation, KILL survivor failure, exact signal ordering, exactly-once guardian release/reap, and combined Cause retention.

## Test or validation evidence
- Mode: TDD
- RED: `npm exec -- vitest run scripts/binary-smoke.test.ts --reporter=verbose`; exit 1 with four expected `TypeError: cleanupGuardianOwnership is not a function` failures before production implementation.
- GREEN: `npm exec -- vitest run scripts/binary-smoke.test.ts --reporter=dot`; 1 file/33 tests passed, exit 0.
- REFACTOR: after wiring the same cleanup operation into the live coordinator and moving evidence acquisition before endpoint readiness, the focused six-file gate passed 80/80 and the real certification completed leak-free.
- Real certification/leak scan: `rm -rf /tmp/expand-binary-smoke-*; ...; npm run cert:cli:build; ...`; exit 0, pre/post process count 0, pre/post temp count 0.
- Desktop E2E/leak scan: `rm -rf /tmp/expand-e2e-home-*; ...; xvfb-run -a npm run e2e:desktop; ...`; 6/6 passed, exit 0, pre/post process count 0, pre/post temp count 0.
- Full suite: `npm run test`; 160 files passed, 1225 passed plus 1 expected failure (1226 total), exit 0.
- Static/build gates: `npm run lint`, `npm run typecheck:all`, `npm run typecheck:effect-audit`, `npm run typecheck:desktop`, `npm run arch`, `npm run knip`, `npm run build`, `npm run build:desktop`, `npm run build --workspace @expand/contracts`, and `npm run build --workspace @expand/client-ts`; each exit 0; architecture covered 189 modules/624 dependencies.
- Repository gates: `npm run agents:check` and `npm run bench:selfcheck`; each exit 0.
- Audit update run 1 and run 2: `npm run effect:audit:update`; each exit 0 with byte-identical files, 0 blocking/88 advisory, 265 grep candidates with migration-debt=0, and 2 launchers with migration-debt=0.
- Audit check: `npm run effect:audit`; exit 0. Semantic baseline, grep migration-debt query, and launcher migration-debt query each returned `[]`.
- Fixture/runner proof: mode 755/100755; SHA-256 `08efc26977082ed72b29359fa3da6a617de0efa287940ca730b6e00546f696d0`; exact launcher record count 1; package runner count 1 for `tsx scripts/binary-smoke.ts`.
- React Doctor: `npx react-doctor@latest --verbose --scope changed`; retained 83/100 with the same one renderer error and three analyzer warnings, exit 1.
- Architecture documentation build: `npm --prefix docs/architecture run build`; exit 1 because the external Playwright `chromium_headless_shell-1228` executable is absent; LikeC4 requested `npx playwright install`.
- Debt/comment/whitespace proof: no semantic, grep, or launcher migration debt; no comment-line diff; `git diff --check` passed.

## Task gate
- Command: `npm exec -- vitest run scripts/binary-smoke.test.ts apps/desktop/test/unit/playwright/effect-test.test.ts test/architecture/effect-audit.test.ts test/architecture/effect-boundary-registry.test.ts test/architecture/manifest-orchestration.test.ts test/architecture/server-app-split.test.ts`
- Result: 6 files/80 tests passed, exit 0.

## Commits
- 2fe5492 fix: terminate binary certification groups

## Self-review
- Capture exact fixture job/PID/PGID evidence before endpoint: satisfied by streamed initial evidence and replacement validation.
- Do not block on `handle.kill`: satisfied; group signals are nonblocking fixture commands followed by explicit bounded verification.
- TERM exact negative PGID, bounded wait, KILL exact negative PGID, bounded verification: satisfied.
- Pre-evidence and post-evidence cleanup: satisfied.
- Guardian release/reap exactly once and no survivors/artifacts: satisfied by the guarded production cleanup path and deterministic regressions.
- Primary and cleanup Cause combination: retained and covered.
- Remove unused Layer/release-counter theater: satisfied.
- Fixture bytes/mode/hash, six E2E cases, real certification, zero debt, one launcher, and no comments: preserved.
- Scope: only binary smoke production/test and this durable report changed; `.pi-subagents/` remains pre-existing and untracked.

## Concerns
- React Doctor continues to exit 1 for the accepted 83/100 baseline outside this wave.
- The architecture-document build remains externally blocked by its missing Playwright headless-shell artifact; all named Task 10 production, static, certification, and E2E gates pass.

# Fix wave (Task 10 binary ownership races)

Status: DONE_WITH_CONCERNS

## Changes
- scripts/binary-smoke.ts: replaced GNU procps `ps -g` use with fail-closed exact full-table PID/PGID parsing; added stopped-child ownership acknowledgement; registered guardian cleanup before interruptibility resumes; made release, reap, and cleanup completion separately atomic; continued and aggregated every best-effort cleanup Cause; and installed an atomic bounded TERM/KILL finalizer immediately with each direct server acquisition.
- scripts/fixtures/job-control.sh: installed the termination trap before spawn, started guardian commands stopped before exec, waited for final status with the job-control wait primitive, and retained exact second-job evidence.
- scripts/binary-smoke.test.ts: added exact PGID parsing, stopped-child handshake, pre-evidence survivor, aggregate cleanup Cause, direct cleanup escalation, and actual production coordinator interruption-at-direct-spawn regressions.
- effect-launchers.json: updated the exact executable fixture SHA-256 to `7a260e6a03859b4f1098acb086603387329976dea7273f359161a2fb7878c720`.
- effect-grep-inventory.json: recorded the two new analyzer-proven `Deferred.await` lexical false positives without debt or reclassification.

## Test or validation evidence
- Mode: TDD.
- RED: `npm exec -- vitest run scripts/binary-smoke.test.ts --reporter=verbose`; exact PGID parser was absent and aggregate cleanup stopped at the first failure instead of retaining four Causes.
- GREEN: `npm exec -- vitest run scripts/binary-smoke.test.ts --reporter=dot`; 39 tests passed before the final production-path regression.
- RED: the live stopped-child handshake regression observed the child marker before acknowledgement; after the fixture handshake it passed and the cached status remained exact.
- RED: `npm exec -- vitest run scripts/binary-smoke.test.ts -t "interrupts the production coordinator after direct-server" --reporter=verbose`; the acquisition-edge interrupt produced no TERM signal because the explicit finalizer was not yet installed.
- GREEN: the same production-path command passed after spawn plus finalizer registration became uninterruptible; the direct process received TERM only, was dead, and its scoped handle released exactly once.
- Final focused binary suite: `npm exec -- vitest run scripts/binary-smoke.test.ts --reporter=dot`; 40/40 passed, exit 0.
- Focused covering gate: `npm exec -- vitest run scripts/binary-smoke.test.ts apps/desktop/test/unit/playwright/effect-test.test.ts test/architecture/effect-audit.test.ts test/architecture/effect-boundary-registry.test.ts test/architecture/manifest-orchestration.test.ts test/architecture/server-app-split.test.ts --reporter=dot`; 6 files/87 tests passed, exit 0 under a 300-second explicit bound. Earlier 50- and 180-second bounds exited 124 while the verbose output showed continued progress; the 300-second rerun proved the gate was slow, not hung.
- Real certification/leak scan: `rm -rf /tmp/expand-binary-smoke-*; npm run cert:cli:build; ...`; exit 0 with pre/post process count 0 and pre/post temp count 0.
- Desktop E2E/leak scan: `xvfb-run -a npm run e2e:desktop`; 6/6 passed, exit 0, with pre/post process count 0 and temp count 0.
- Full suite: `npm run test`; 160 files passed, 1232 passed plus 1 expected failure (1233 total), exit 0.
- Static/repository gates: `npm run lint`, `npm run typecheck:all`, `npm run typecheck:desktop`, `npm run arch`, `npm run knip`, `npm run agents:check`, and `npm run bench:selfcheck`; each exit 0; architecture covered 189 modules/624 dependencies.
- Builds: `npm run build`, `npm run build:desktop`, `npm run build --workspace @expand/contracts`, and `npm run build --workspace @expand/client-ts`; each exit 0.
- Audit pre-edit regression: `npm run effect:audit:update`; exit 1 for exactly two new visible `Deferred.await` lexical candidates. Both received narrow analyzer-proven `false-positive` records.
- Audit idempotence: two final consecutive `npm run effect:audit:update` executions exited 0 with byte-identical hashes: semantic baseline `4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945`, grep inventory `7ddc2173a556f2085c27213046f30fb77a6ab40647671d612702a6435ce6cf12`, launcher inventory `7527d133dd857f332a1c0eb06c2d65fc46cc7beba561ad26fc3074248f3ba5db`.
- `npm run effect:audit`; exit 0 with 0 blocking findings, semantic baseline `[]`, 267 grep candidates with migration-debt=0, and 2 launchers with migration-debt=0. `npm run effect:grep > /tmp/expand-effect-stage4-grep.txt` exited 0.
- Fixture proof: mode 755/100755 and SHA-256 `7a260e6a03859b4f1098acb086603387329976dea7273f359161a2fb7878c720`, matching the launcher registry.
- React Doctor: `npx react-doctor@latest --verbose --scope changed`; retained 83/100 with the same one renderer error and three analyzer warnings, exit 1.
- Architecture docs build: `npm --prefix docs/architecture run build`; exit 1 because the external Playwright `chromium_headless_shell-1228` executable remains absent.
- `git diff --check`; exit 0. No comment line was added.

## Task gate
- Command: complete Task 10 focused/live/model, real certification, six-flow E2E, full test, audit/debt, static, repository, build, fixture, React Doctor, leak, and whitespace matrix listed above.
- Result: every named Task 10 gate passed; focused gate 6 files/87 tests, full suite 160 files/1233 tests with one expected failure, real certification and desktop E2E leak-free, and audit twice byte-idempotent with zero migration debt.

## Commits
- acb9a4d fix: close binary ownership races

## Self-review
- Exact PGID selection uses `ps -eo pid=,pgid=` and strict numeric full-row parsing, including valid kernel PGID 0 rows; verified after normal departure, TERM, KILL, reap, and finalization: satisfied.
- Guardian child cannot execute before `%2`/PID/PGID evidence is emitted and coordinator CONT acknowledgement arrives; fixture termination trap is installed before spawn: satisfied.
- Guardian cleanup is registered at the acquisition boundary and pre-evidence cleanup probes discoverable startup children rather than hard-coding absence: satisfied.
- Release, reap, and cleanup completion have distinct atomic reservations; failures reset reservations for later finalization, and all cleanup operations continue with combined Causes: satisfied.
- Every direct server spawn atomically installs a bounded TERM/probe/KILL/probe/artifact finalizer before interruptibility resumes: satisfied by the acquisition-edge RED/GREEN production regression.
- Deterministic helper/service-layer regressions cover TERM success, TERM-to-KILL, KILL survivor, exactly-once release/reap, combined primary/cleanup Cause, stopped evidence, pre-evidence interruption, direct-spawn interruption, and no live fixture/certification survivors: satisfied.
- Fixture boundary, executable mode/hash, zero semantic/grep/launcher debt, prior E2E cwd correction, comments, and scope: preserved.

## Concerns
- React Doctor retains the accepted pre-existing 83/100 findings outside Task 10 and exits 1.
- The architecture-document build remains externally blocked by the missing Playwright headless-shell artifact; it is outside the named Task 10 matrix.

# Fix wave (Task 10 final binary ownership cleanup)

Status: DONE_WITH_CONCERNS

## Changes
- scripts/fixtures/job-control.sh: discovers the active job PID and exact PGID when TERM arrives before shell variable publication, then CONT/TERM/KILLs and waits/reaps the stopped child.
- scripts/binary-smoke.ts: registers guardian and direct-server cleanup in the same uninterruptible spawn edge; preserves production primary and cleanup Causes; discovers pre-evidence startup PGID before guardian death; adds the production ownership phase core; makes release reservation plus CONT atomic with failure/interruption rollback; and drives coordinator timeouts through the pure model.
- scripts/binary-smoke-model.ts: adds the typed pure endpoint, departure, guardian-reap, and direct-server timeout transition.
- scripts/binary-smoke.test.ts: adds production-core failure/interruption coverage at guardian spawn, stopped evidence, endpoint publication, lock observation, release, and reap; atomic release regressions; a real TERM-resistant stopped-child pre-evidence regression; pure timeout cases; and an actual production direct-server primary-plus-cleanup Cause regression.
- effect-launchers.json: updates the exact executable fixture SHA-256.
- effect-grep-inventory.json: adds the two analyzer-proven Deferred.await lexical false positives introduced by the release regressions, with zero migration debt.

## Test or validation evidence
- Mode: TDD.
- RED: `npm exec -- vitest run scripts/binary-smoke.test.ts -t "models the|rolls back" --reporter=verbose`; exit 1 because timeoutTransition and reserveGuardianRelease were absent.
- GREEN: `npm exec -- vitest run scripts/binary-smoke.test.ts -t "models the|release reservation|delivers CONT" --reporter=verbose`; 6 passed, exit 0.
- RED: `npm exec -- vitest run scripts/binary-smoke.test.ts -t "production direct-server parse" --reporter=verbose`; exit 1 because runOwnedCli was not exported and production finalization did not retain cleanup Cause.
- GREEN: the same command; 1 passed, exit 0 with production parse Fail and cleanup Die retained.
- RED: `npm exec -- vitest run scripts/binary-smoke.test.ts -t "TERM-resistant stopped child" --reporter=verbose`; exit 1 because the pre-evidence stopped child remained alive.
- GREEN: the same command after fixture job discovery/escalation; 1 passed, exit 0 with the owned PID/PGID identity absent. The full-suite regression was refined to distinguish rapid numeric PID/PGID reuse from the original owned identity; the final full suite passed.
- RED: `npm exec -- vitest run scripts/binary-smoke.test.ts -t "production-core ownership" --reporter=verbose`; six expected TypeErrors because runBinaryOwnershipCore was absent.
- GREEN: the same focused phase selector after implementation; 12 production-core phase failure/interruption cases passed, exit 0.
- Focused binary suite: `npm exec -- vitest run scripts/binary-smoke.test.ts --reporter=dot`; 60/60 passed, exit 0.
- Covering files: scripts/binary-smoke.test.ts; apps/desktop/test/unit/playwright/effect-test.test.ts; test/architecture/effect-audit.test.ts; test/architecture/effect-boundary-registry.test.ts; test/architecture/manifest-orchestration.test.ts; test/architecture/server-app-split.test.ts.
- Final covering command: `timeout 600s npm exec -- vitest run scripts/binary-smoke.test.ts apps/desktop/test/unit/playwright/effect-test.test.ts test/architecture/effect-audit.test.ts test/architecture/effect-boundary-registry.test.ts test/architecture/manifest-orchestration.test.ts test/architecture/server-app-split.test.ts --reporter=dot`; 6 files/107 tests passed, exit 0 in 187.33 seconds. The prior detached run was terminated after diagnosis; it had not hung, and the explicit 600-second bound covers the known slow audit architecture cases.
- Real certification/leak scan: `npm run cert:cli:build`; exit 0; pre/post process count 0 and `expand-binary-smoke-*` temp count 0.
- Desktop: `npm run build:desktop`; exit 0. `xvfb-run -a npm run e2e:desktop`; 6/6 passed, exit 0; pre/post task process count 0 and `expand-e2e-home-*` temp count 0.
- Full suite: `timeout 700s npm run test`; 160 files passed, 1252 passed plus 1 expected failure (1253 total), exit 0.
- Static/repository gates: `npm run lint`, `npm run typecheck:all`, `npm run typecheck:effect-audit`, `npm run typecheck:desktop`, `npm run arch`, `npm run knip`, `npm run agents:check`, and `npm run bench:selfcheck`; each exit 0; architecture covered 189 modules/624 dependencies.
- Benchmark smoke: `npm run bench:events -- --smoke`; all six reported scenarios PASS, exit 0.
- Builds: `npm run build`, `npm run build:desktop`, `npm run build --workspace @expand/contracts`, and `npm run build --workspace @expand/client-ts`; each exit 0.
- Audit pre-inventory evidence: focused audit reported exactly 2 additions and 0 implicit reclassifications, both new Deferred.await lexical identities.
- Audit idempotence: two final consecutive `npm run effect:audit:update` commands exited 0 with byte-identical hashes: semantic baseline `4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945`, grep inventory `c326a98c7eddbe28b7ca7d68d7b1ad1fdad6a3ca63eab0f2214aeb8a74ed0ec8`, launcher inventory `1ec3de20862e337ce3e05cd5d42fa9e43e25286b2bc82dab7e33cc04a61d5af3`.
- `npm run effect:audit`; exit 0 with 0 blocking, semantic baseline `[]`, 269 grep candidates with migration-debt=0, and 2 launchers with migration-debt=0. `npm run effect:grep` exited 0.
- Fixture proof: Git mode 100755; SHA-256 `6691c8a7cee5937b2ce2ee95025984d1c070287cfbd6dd6027d6181c8308aa4c`; launcher registry exact match. Package runner remains exactly `tsx scripts/binary-smoke.ts` and the file retains one NodeRuntime runMain entry.
- React Doctor: `npx react-doctor@latest --verbose --scope changed`; retained 83/100 with the accepted existing one renderer error and three analyzer warnings, exit 1 without regression.
- Whitespace/debt: `git diff --check` passed; semantic, grep, and launcher migration debt are all zero; no comments were added.

## Task gate
- Command: complete Task 10 focused/live/model, certification, six-flow E2E, full suite, audit/debt, static, repository, benchmark, build, fixture, React Doctor, leak, and whitespace matrix listed above.
- Result: every required Task 10 pass/fail gate passed; React Doctor retained its accepted 83/100 diagnostic baseline and intentionally exits 1.

## Commits
- 7713644 fix: finalize binary ownership cleanup.

## Self-review
- Pre-evidence race/orphan cleanup: satisfied by trap-side exact job discovery, production pre-death PGID capture, post-orphan exact group verification, atomic spawn/cleanup edge, and real TERM-resistant stopped-child regression.
- Production Cause retention: satisfied for guardian and direct-server production composition; actual direct production parse-plus-cleanup Cause is asserted.
- Release atomicity: satisfied; reservation and CONT are uninterruptible, every failure Exit resets the reservation, external interruption cannot split delivery, and exactly-once retry behavior is covered.
- Production acquisition phases: satisfied for guardian spawn, stopped evidence, endpoint publication, lock observation, release, and reap under failure and interruption, with TERM/KILL ordering, bounded cleanup, no owned process/artifact state, and exactly-once reservations.
- Pure timeout transition: satisfied and used by every coordinator timeout path with four persistent model cases.
- Prior exact PGID parsing, stopped-before-exec handshake, direct finalization, fixture boundary, real certification, E2E cwd correction, zero debt, and comments: preserved.
- Scope: only the four binary-smoke source/test/fixture files, the two exact registries, and this report changed; pre-existing `.pi-subagents/` was not staged.

## Concerns
- React Doctor continues to report the accepted pre-existing 83/100 baseline outside this fix wave and therefore exits 1.

# Fix wave (Task 10 centralized binary cleanup policy)

Status: DONE_WITH_CONCERNS

## Changes
- scripts/binary-smoke.ts: freezes the guardian before pre-evidence discovery, applies coordinator-owned bounded TERM/probe/KILL/probe cleanup to the exact discovered startup PGID, continues guardian termination/reap and final verification best-effort, and makes guardian spawn the real atomic production-core acquisition returning the handle consumed by every later stage and cleanup.
- scripts/fixtures/job-control.sh: removes all trap and escalation policy while retaining only job-control enable/start/capture/PGID/signal/wait and STOP/CONT release facts.
- scripts/binary-smoke.test.ts: exercises the production acquisition seam across every phase with exact-once release/reap, combined Cause, exact signal order, and a live frozen-guardian/TERM-resistant stopped-child no-survivor regression without fixture cleanup assistance.
- effect-launchers.json: updates the exact executable fixture SHA-256 while preserving mode and host-fixture classification.

## Test or validation evidence
- Mode: TDD.
- RED: `npm exec -- vitest run scripts/binary-smoke.test.ts --reporter=verbose`; exit 1 with nine expected failures because pre-evidence cleanup did not freeze or signal the discovered PGID, the old production core did not pass an acquired guardian to stages/cleanup, and the live no-survivor path could not complete.
- GREEN: `npm exec -- vitest run scripts/binary-smoke.test.ts --reporter=dot`; 61/61 passed, exit 0.
- Covering files: `scripts/binary-smoke.test.ts`, `apps/desktop/test/unit/playwright/effect-test.test.ts`, `test/architecture/effect-audit.test.ts`, `test/architecture/effect-boundary-registry.test.ts`, `test/architecture/manifest-orchestration.test.ts`, and `test/architecture/server-app-split.test.ts`.
- Covering command: `timeout 600s npm exec -- vitest run scripts/binary-smoke.test.ts apps/desktop/test/unit/playwright/effect-test.test.ts test/architecture/effect-audit.test.ts test/architecture/effect-boundary-registry.test.ts test/architecture/manifest-orchestration.test.ts test/architecture/server-app-split.test.ts --reporter=dot`; 6 files/108 tests passed, exit 0.
- Real certification/leak scan: `rm -rf /tmp/expand-binary-smoke-*; timeout 240s npm run cert:cli:build; ...`; exit 0 with pre/post process count 0 and temp count 0.
- Desktop E2E/leak scan: `rm -rf /tmp/expand-e2e-home-*; timeout 600s xvfb-run -a npm run e2e:desktop; ...`; 6/6 passed, exit 0, with pre/post process count 0 and temp count 0.
- Full suite: `timeout 700s npm run test`; 160 files passed, 1253 passed plus 1 expected failure (1254 total), exit 0.
- Static/repository gates: `npm run lint`, `npm run typecheck:all`, `npm run typecheck:effect-audit`, `npm run typecheck:desktop`, `npm run arch`, `npm run knip`, `npm run agents:check`, and `npm run bench:selfcheck`; each exit 0; architecture covered 189 modules/624 dependencies.
- Builds and benchmark: `npm run build`, `npm run build:desktop`, `npm run build --workspace @expand/contracts`, `npm run build --workspace @expand/client-ts`, and `npm run bench:events -- --smoke`; each exit 0 and all six benchmark scenarios passed.
- Audit pre-correction validation: `timeout 300s npm run effect:audit:update`; exit 1 after the new fixture bytes and visible interim Effect composition changed exact inventories; no file was silently updated.
- Audit idempotence: two final consecutive `npm run effect:audit:update` commands exited 0 with byte-identical hashes: semantic baseline `4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945`, grep inventory `c326a98c7eddbe28b7ca7d68d7b1ad1fdad6a3ca63eab0f2214aeb8a74ed0ec8`, launcher inventory `917a64e3454b494a32d3b82f54c33457ce191613b79e7a20b9a8ab16abeb9888`.
- `npm run effect:audit`; exit 0 with 0 blocking, semantic baseline `[]`, 269 grep candidates with migration-debt=0, and 2 launchers with migration-debt=0. `npm run effect:grep` exited 0.
- Fixture proof: mode 755/100755; SHA-256 `b09ba5e6a28d30b8e28dde0c09a2c41e84fab54c1c544c0089b9d2b2ea280591`; launcher registry exact match; no trap or shell-owned cleanup policy remains.
- Runner proof: package scripts contain exactly one `tsx scripts/binary-smoke.ts`; production retains exactly one NodeRuntime entry.
- React Doctor: `npx react-doctor@latest --verbose --scope changed`; retained the accepted 83/100 with one existing renderer error and three existing analyzer warnings, exit 1 without regression.
- Architecture documentation build: `npm --prefix docs/architecture run build`; exit 1 because the external Playwright `chromium_headless_shell-1228` artifact is absent; LikeC4 requested `npx playwright install`.
- `git diff --check`; exit 0. No comments were added.

## Task gate
- Command: complete Task 10 focused/live/model, certification, six-flow E2E, full suite, audit/debt, static, repository, benchmark, build, fixture, React Doctor, leak, and whitespace matrix listed above.
- Result: every required Task 10 pass/fail gate passed; React Doctor retained its accepted diagnostic baseline, and the architecture-document build remained externally unavailable for the same missing browser artifact.

## Commits
- Pending `fix: centralize binary cleanup policy`.

## Self-review
- Coordinator-owned pre-evidence cleanup freezes guardian before exact direct-child discovery and performs bounded group TERM/probe/KILL/probe before guardian termination/reap and final verification: satisfied.
- Guardian already-dead and signal races continue best effort and fail closed when ownership cannot be verified: satisfied.
- Fixture contains no cleanup function, traps, timing, or escalation policy: satisfied.
- Actual production guardian acquisition returns the handle consumed by evidence, endpoint, locks, release, reap, and cleanup in one atomic acquisition edge: satisfied.
- Phase failure/interruption, exact-once release/reap, exact signals, no PID/PGID/files/temp residue, combined Cause, and live no-survivor behavior: satisfied.
- Exact hash/mode/inventories, zero semantic/grep/launcher debt, prior behavior, E2E, and comments: preserved.
- Scope: only binary smoke production/test/fixture, exact launcher inventory, and this durable report changed; pre-existing `.pi-subagents/` was not staged.

## Concerns
- React Doctor retains the accepted pre-existing 83/100 findings outside Task 10 and exits 1.
- The architecture-document build remains externally blocked by the missing Playwright headless-shell artifact; it is outside the named Task 10 gate.
