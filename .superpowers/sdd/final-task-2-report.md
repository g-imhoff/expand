# Implementation report

Status: DONE

## Changes
- `effect-executable-inventory.json`: added the canonical version-1 inventory with 27 live entrypoints and 74 exact invocation observations.
- `scripts/effect-executable-inventory.ts`: added Schema-decoded inventory validation, independent Git mode/shebang and tracked-path discovery, five-manifest parsing, esbuild/Electron/module-runner/example/benchmark/child-program discovery, declaration and selector identities, strict bijection checks, exact host mode/hash validation, sole fixture primitive enforcement, and preload transport-shim restrictions.
- `scripts/effect-executable-inventory.test.ts`: added model, identity, adversarial path/declaration/kind/selector/occurrence/mode/hash, and sole-fixture tests.
- `test/architecture/effect-executable-inventory.test.ts`: added the live repository bijection, launcher gate, final-registry removal, manifest-gate entry, and preload-shim architecture tests.
- `scripts/effect-audit.ts`: integrated the reusable executable-inventory validation into the permanent audit command and removed migration launcher collection, comparison, classification, update, and result paths.
- `scripts/effect-inventory-model.ts`: removed the migration launcher schema and compare/shrink model while retaining the Task 4 grep model.
- `scripts/effect-audit.test.ts`: removed obsolete migration launcher model/command fixtures and retained the permanent audit coverage.
- `test/architecture/effect-audit.test.ts`: removed obsolete migration launcher-registry assertions.
- `package.json`: added `effect:launchers` with no update or generation command.
- `test/architecture/manifest-orchestration.test.ts`: registered the exact new root manifest command.
- `effect-grep-inventory.json`: registered the two exact executable-inventory runner strings as audit fixtures, with migration debt remaining zero.
- `effect-launchers.json`: deleted the migration launcher registry.

## Test or validation evidence
- Mode: TDD
- RED command/result: `npm exec -- vitest run scripts/effect-executable-inventory.test.ts test/architecture/effect-executable-inventory.test.ts` exited 1 because `scripts/effect-executable-inventory.ts` did not exist.
- GREEN command/result: `npm exec -- vitest run scripts/effect-executable-inventory.test.ts` passed 4/4 after the initial schema/bijection implementation.
- RED command/result: `npm exec -- vitest run scripts/effect-executable-inventory.test.ts` exited 1 when the new sole-fixture test proved two fixture invocation links were accepted.
- GREEN command/result: `npm exec -- vitest run scripts/effect-executable-inventory.test.ts` passed 5/5 after enforcing the exact job-control primitive link.
- RED command/result: `npm exec -- vitest run test/architecture/effect-executable-inventory.test.ts --reporter=verbose` exited 1 with an invocation-bijection failure after the newly tracked validator source exposed self-discovery and the manifest-invoked architecture entry remained absent.
- GREEN command/result: `npm exec -- vitest run test/architecture/effect-executable-inventory.test.ts` passed 3/3 after excluding validator fixture literals from child discovery and discovering the direct Vitest manifest entry.
- RED command/result: `npm run test` exited 1 because the exact root manifest catalog lacked `effect:launchers` and the unstaged deleted registry still appeared in the Git index.
- GREEN command/result: `npm exec -- vitest run test/architecture/manifest-orchestration.test.ts test/architecture/node-only.test.ts` passed 19/19 after updating the exact catalog and staging the deletion.
- Final focused GREEN: `npm exec -- vitest run scripts/effect-executable-inventory.test.ts test/architecture/effect-executable-inventory.test.ts` passed 8/8 in 2 files, exit 0.

## Task gate
- `npm ci`: installed 549 packages; exit 0. npm reported the existing audit summary of 3 dependency vulnerabilities.
- `npm ci --prefix docs/architecture`: installed 126 packages; exit 0. npm reported the existing audit summary of 2 low-severity dependency vulnerabilities.
- `npm run agents:check`: synchronized; exit 0.
- `npm exec -- vitest run scripts/effect-executable-inventory.test.ts test/architecture/effect-executable-inventory.test.ts`: 2 files and 8 tests passed; exit 0.
- `npm run effect:audit`: 0 blocking findings, 75 advisories, 280 exact grep candidates, migration-debt=0; executable inventory validation passed; exit 0.
- `npm run effect:grep > /tmp/expand-effect-final-task-2-grep.txt`: completed; exit 0.
- `npm run effect:launchers`: 1 file and 3 live architecture tests passed; exit 0.
- `npm run lint`: passed; exit 0.
- `npm run typecheck:all`: passed; exit 0.
- `npm run arch`: 189 modules and 624 dependencies, no violations; exit 0.
- `npm run knip`: passed; exit 0.
- `npm run test`: 164 files passed, 1275 tests passed and 1 expected failure; exit 0. An earlier full run exposed one transient job-control status 147; the focused 61-test binary suite and the fresh complete suite both passed afterward.
- `npm run bench:selfcheck`: `selfcheck OK`; exit 0.
- `npm run bench:events -- --smoke`: all six benchmark rows passed; exit 0.
- `npm run build`: passed; exit 0.
- `npm run cert:cli:build`: passed; exit 0.
- `npm run build:desktop`: passed; exit 0.
- `xvfb-run -a npm run e2e:desktop`: 6/6 Playwright tests passed; exit 0.
- `npm run cert:packages`: real package build/stage/pack/inspect certification passed; exit 0.
- `git ls-files -s .githooks/pre-commit scripts/fixtures/job-control.sh`: both exact modes are `100755`; exit 0.
- `sha256sum .githooks/pre-commit scripts/fixtures/job-control.sh` plus inventory `jq`: both hashes exactly match the inventory; exit 0.
- `{ find . -maxdepth 5 -name '*.tgz'; find . -maxdepth 5 -name 'dist-publish'; find . -maxdepth 5 -name '.dist-publish.next'; find . -maxdepth 5 -name '.dist-publish.previous'; } | sort -u`: no residue; exit 0.
- Added-comment scan: no added TypeScript comments; exit 0.
- Migration launcher symbol/path scan over executable/configuration roots: no surviving production/model reference; exit 0.
- `git diff --check`: passed; exit 0.

## Commits
- `HEAD` `build: inventory executable boundaries` (final SHA returned in the completion handoff)

## Self-review
- Exact scoped inventory/model/tests/audit integration: satisfied.
- Schema-decoded versioned model with file, declaration kind/name, exact kind, occurrence-indexed invocations, optional exact host boundary, and SHA-256: satisfied.
- Independent Git modes/shebangs, five manifests, esbuild, Electron main/preload/renderer, registered module runners, examples, benchmarks, child fixtures, and child-launched program discovery: satisfied.
- Strict path/declaration/invocation bijection, no glob/directory/untracked/duplicate identities, exact runner links, and current hashes: satisfied and adversarially tested.
- Exact host mode/hash, sole retained job-control fixture with one primitive invocation, and sole Effect-free preload shim without direct Effect or Node platform service imports: satisfied.
- Live derived inventory count with CLI/server/TUI/Electron, runtime/build/audit/fold/sync/binary/package/staging scripts, examples, benchmarks, lock contenders, hook, fixture, and manifest gate: satisfied; no hardcoded count in production.
- Permanent audit integration, zero migration debt, deleted launcher registry/model/update paths, and no final inventory generator/update command: satisfied.
- No code comments added and no unrelated dependency or behavior changes: satisfied.

## Concerns
- None

# Fix wave

Status: DONE

## Changes
- `scripts/effect-executable-inventory.ts`: replaced registry-seeded and set-collapsed discovery with parsed manifest, child-process, declaration, runner, shell, and preload discovery that retains exact source-ordered occurrences and rejects missing, ambiguous, or unregistered boundaries.
- `effect-executable-inventory.json`: updated the exact live bijection to 27 entrypoints and 93 independently parsed invocation observations, including every repeated launch occurrence.
- `scripts/effect-executable-inventory.test.ts`: added closed shell grammar and complete preload module-form adversarial tests.
- `test/architecture/effect-executable-inventory.test.ts`: added actual-collector synthetic repositories for multiple manifest targets, repeated child calls, child-only inventory failure, exact synthetic declaration exclusion, preload drift, and unregistered, aliased, and multiple runner failure; strengthened the live assertions through the exact validator.
- `scripts/binary-smoke.ts`: routed fact, guardian, and signal modes through one `ChildProcess.make` fixture consumer helper.
- `scripts/binary-smoke.test.ts`: added the covering one-helper fixture-mode test and moved the live guardian launch through that helper.
- `scripts/effect-audit.ts`: preserved typed executable-inventory failures while handling platform failures from complete repository discovery.

## Test or validation evidence
- Mode: TDD
- RED: `npm exec -- vitest run scripts/effect-executable-inventory.test.ts` exited 1 because the new shell and preload parsers were absent; after correcting the assertion to inspect the typed error, GREEN passed 7/7.
- RED: `npm exec -- vitest run test/architecture/effect-executable-inventory.test.ts --reporter=verbose` exited 1 because the old collector failed on a synthetic repository before discovering occurrences and then exposed registry-seeded/stale runner behavior; GREEN passed after parsed independent discovery and exact occurrence retention.
- RED: `npm exec -- vitest run scripts/binary-smoke.test.ts -t "routes every fixture mode"` exited 1 with `jobControlCommand is not a function`; GREEN passed 1/1 after introducing the sole consumer helper.
- RED: `npm exec -- vitest run test/architecture/effect-executable-inventory.test.ts -t "unregistered and multiple"` exited 1 because an aliased runner produced a successful empty discovery; GREEN passed 1/1 after import-alias-aware runner parsing.
- RED validation: bounded `npm run effect:audit` reported 5 blocking findings from newly added native JSON fixture encoding, then 13 exact grep additions from synthetic fixture strings; the tests were corrected to use `Schema.UnknownFromJsonString` and non-candidate fixture spellings. GREEN audit reported 0 blocking findings, 75 advisories, 280 exact grep candidates, and migration-debt=0.
- Covering test files: `scripts/effect-executable-inventory.test.ts`, `test/architecture/effect-executable-inventory.test.ts`, and `scripts/binary-smoke.test.ts`.
- Covering rerun: `npm exec -- vitest run scripts/effect-executable-inventory.test.ts test/architecture/effect-executable-inventory.test.ts scripts/binary-smoke.test.ts` passed 3 files and 76 tests, exit 0.

## Task gate
- `npm ci`: passed with no tracked changes, exit 0.
- `npm ci --prefix docs/architecture`: passed, exit 0.
- `npm run agents:check`: synchronized, exit 0.
- `npm exec -- vitest run scripts/effect-executable-inventory.test.ts test/architecture/effect-executable-inventory.test.ts scripts/binary-smoke.test.ts`: 3 files and 76 tests passed, exit 0.
- `setsid timeout --foreground --signal=TERM --kill-after=5s 120s npm run effect:audit`: 0 blocking findings, 75 advisories, 280 candidates, migration-debt=0; exit 0.
- `npm run effect:grep > /tmp/expand-effect-final-task-2-fix-grep.txt`: passed, exit 0.
- `npm run effect:launchers`: 1 file and 7 tests passed, exit 0.
- `npm run lint`: passed, exit 0.
- `npm run typecheck:all`: passed, exit 0.
- `npm run arch`: 189 modules and 624 dependencies with no violations, exit 0.
- `npm run knip`: passed, exit 0.
- `npm run test`: 164 files passed; 1282 tests passed and 1 expected failure, exit 0.
- `npm run bench:selfcheck`: `selfcheck OK`, exit 0.
- `npm run bench:events -- --smoke`: all six benchmark rows passed, exit 0.
- `npm run build`: passed, exit 0.
- `npm run cert:cli:build`: passed, exit 0.
- `npm run build:desktop`: passed, exit 0.
- `xvfb-run -a npm run e2e:desktop`: 6/6 passed, exit 0.
- `npm run cert:packages`: passed, exit 0.
- `git ls-files -s .githooks/pre-commit scripts/fixtures/job-control.sh` and SHA-256 comparison: both modes are `100755` and both inventory hashes match, exit 0.
- Package residue scan, added-comment scan, and production migration-launcher scan: no matches, exit 0.
- `git diff --check`: passed, exit 0.

## Commits
- `HEAD` `fix: prove executable inventory completeness` (exact SHA returned in the completion handoff)

## Self-review
- Every invocation occurrence is retained with caller, selector, and source-order occurrence; multiple manifest targets and repeated calls are proven synthetically and live: satisfied.
- Child discovery parses every tracked TypeScript/JavaScript caller independently and ignores only exact string-literal synthetic declarations: satisfied.
- Declarations and module runners are parsed before registry comparison; missing, aliased, unregistered, ambiguous, and multiple runners cannot be disabled by an absent host boundary: satisfied.
- All job-control modes use one exact fixture consumer and the shell validator admits only the retained closed grammar while rejecting polling, network, filesystem, substitution, and cleanup-policy drift: satisfied.
- Static, side-effect, dynamic, require/alias, import-equals, export-from, export-star, Effect, and Node builtin preload forms are parsed and rejected: satisfied.
- Synthetic and live collector tests prove exact observations and occurrences, child-only failure, fixture exclusion, preload drift, fixture drift, and exact inventory bijection: satisfied.
- No updater/generator, migration registry, migration debt, comments, unrelated behavior, or unrelated tracked files were added: satisfied.

## Concerns
- None
