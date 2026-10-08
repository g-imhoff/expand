---
schema_version: expskill.setup-test.v1
status: ready
---

# Setup Test

## Status

The project-native test-method matrix is ready at source revision `f94e25befefe09d77d13fd39ffc96ac16592f7d9`, tree `ad3a017a704776cf09334f30dda7d7d3b8f528cd`. The approved runnable method proof passed. This record does not declare product readiness or a green GitHub CI run.

Dependency audit independently failed with actual exit 1, one high and 12 moderate findings. It remains a required CI gate and blocks final PR readiness. The delegated AI user explicitly accepted method-record eligibility separately from that failed gate. This is an interim workflow decision, not human product risk acceptance or an audit waiver. ACP assistant/responsibilities implementation remains pending under `docs/concepts/acp-assistant-and-responsibilities.md`.

## Test inventory

`package.json`, `vitest.config.ts`, `apps/desktop/e2e/playwright.config.ts`, and `.github/workflows/ci.yml` own the existing runners. All listed methods ran locally. Hosted GitHub jobs were not executed as part of this proof.

| Suite | Scope and layer | Runner/environment |
| --- | --- | --- |
| Vitest normal project | Unit and component tests, backend integration, contract/property tests, scripts/examples, architecture/support tests | `npm test`; Node; desktop UI files select happy-dom through existing setup |
| Vitest process-heavy project | State-root election, keep-running lifecycle, spawn-lock, archive-stale smoke | Same full command; existing ordered project with file parallelism disabled |
| Architecture/static analysis | All 18 architecture files, compiler enforcement and Knip; lint/typecheck/Knip scripts | Full Vitest includes 115 architecture tests; separate quality commands |
| Compiled binary certification | Real built CLI/backend executables and lifecycle behavior | `npm run verify:compiled-binaries` |
| Package certification | Actual packed package consumer installation and execution | `npm run verify:package-artifacts`; existing normal install hooks |
| Packaged native desktop | All eight project cases, backend RPC, desktop/mobile sidebar, settings, theme changes and persistence | Electron/Playwright on the native display; fresh owned profile per launch |
| Supplemental packaged reload | Real settings and project hash-route reloads, file identity, unchanged URL/new timeOrigin, backend read/create/persistence, no alerts/page errors | Retained ignored fixture and config; no mock bridge or provider call |
| Dependency audit | Locked dependency advisories | `npm audit --audit-level=high`; independent required CI gate, currently failed |

Proof used Node 24.17.0, npm 11.12.1, Electron 42.10.0, Vitest 5.0.3, Playwright 1.61.1, TypeScript 6.0.3, Knip 6.26.0, happy-dom 20.10.6 and Effect language service 0.86.6. These are installed versions from the existing locked installation. Repository Node requirement is `>=24.15` and the declared package manager is npm 11.12.1. No runtime or dependencies were installed in this resume.

The local proof used existing task-local npm, Electron, electron-builder and browser caches. Native display availability is required. A failed native launch stops before installing or altering the environment. CI's existing desktop job uses Xvfb and its own dependency preparation; local native-display proof does not certify that hosted environment.

## Commands

The proved working directory is `/home/gimhoff/projects/personal/expand/.worktrees/setup-test-acp`. Its retained `.tmp/setup-test-runtime/bin` and existing dependencies are prerequisites for reproducing this exact run. Normal installation hooks and the Effect compiler patch remain required; do not bypass them. On a new checkout, its owning workflow must prepare the declared runtime and locked dependencies within its authorized scope.

Both humans and agents use this isolation wrapper for the methods below. It does not print credential values and verifies the key-file override is nonexistent, including no dangling symlink.

```sh
proof_env() {
  test ! -e "$PWD/.tmp/setup-test-resume-proof/no-provider-key" || return 1
  test ! -L "$PWD/.tmp/setup-test-resume-proof/no-provider-key" || return 1
  env -u OPENCODE_ZEN_API_KEY -u OPENCODE_API_KEY -u ELECTRON_RUN_AS_NODE \
    PATH="$PWD/.tmp/setup-test-runtime/bin:$PWD/node_modules/.bin:$PATH" \
    CI=1 UPDATE_SNAPSHOT=none \
    EXPAND_ZEN_API_KEY_FILE="$PWD/.tmp/setup-test-resume-proof/no-provider-key" \
    npm_config_cache="$PWD/.cache/setup-test-npm" \
    ELECTRON_CACHE="$PWD/.cache/setup-test-electron" \
    ELECTRON_BUILDER_CACHE="$PWD/.cache/setup-test-electron-builder" \
    PLAYWRIGHT_BROWSERS_PATH="$PWD/.cache/setup-design-browsers" \
    "$@"
}
```

The exact fresh commands are:

```sh
proof_env npm test -- \
  packages/contracts/test/automation-contracts.test.ts \
  apps/desktop/test/ui/app-sidebar.test.tsx \
  apps/desktop/test/ui/settings-page.test.tsx \
  apps/desktop/test/ui/settings-connection.test.tsx \
  apps/server/test/integration/automation-configuration-repository.test.ts \
  --update=none --allowOnly=false --retry=0 \
  --reporter=default --reporter=json \
  --outputFile.json=.tmp/setup-test-f94-proof/canary.json

proof_env env NODE_ENV=production npm test -- \
  --update=none --allowOnly=false --retry=0 \
  --reporter=default --reporter=json \
  --outputFile.json=.tmp/setup-test-f94-proof/full.json

proof_env npm audit --audit-level=high --json
```

The remaining mappings use the same wrapper:

| Type | Copyable command | Scope |
| --- | --- | --- |
| Lint | `proof_env npm run lint` | Repository ESLint rules |
| Typecheck | `proof_env npm run typecheck` | Entire workspace and Effect compiler diagnostics |
| Dead code/dependencies | `proof_env npm run knip` | Existing Knip configuration |
| Compiled binaries | `proof_env npm run verify:compiled-binaries` | Native executable certification |
| Package consumer | `proof_env npm run verify:package-artifacts` | Packed artifacts and isolated consumer installation |
| Desktop build | `proof_env npm run build:desktop` | Fresh desktop production package; existing build command never publishes |
| Native desktop | `proof_env env PLAYWRIGHT_JSON_OUTPUT_FILE="$PWD/.tmp/test-method-routine/desktop.json" node node_modules/@playwright/test/cli.js test -c apps/desktop/e2e/playwright.config.ts --workers=1 --retries=0 --forbid-only --fail-on-flaky-tests --update-snapshots=none --reporter=list,json --output=.tmp/test-method-routine/desktop-results` | All eight existing cases against the prepared package |
| Retained supplemental gate | `proof_env env PLAYWRIGHT_JSON_OUTPUT_FILE="$PWD/.tmp/test-method-routine/hash-route.json" node node_modules/@playwright/test/cli.js test -c .tmp/correct-profile-proof/hash-route.config.ts --workers=1 --retries=0 --forbid-only --fail-on-flaky-tests --update-snapshots=none --reporter=list,json --output=.tmp/test-method-routine/hash-route-results` | One real packaged reload/read/mutation case; retained ignored fixture required |

The last two commands direct future output away from retained evidence. Their executed historical commands and actual exit codes are recorded in `.tmp/setup-test-f94-proof/reuse-binding.json`; they were not rerun during this resume. The supplemental config points to `.tmp/setup-test-resume-proof/packaged/hash-route-rpc.spec.ts`. Those ignored sources are available in the retained selected checkout, not in a fresh clone. Preserve the fresh proof output files before any reproduction, and use distinct ignored result paths for later routine runs. Do not overwrite earlier attempts.

## Canary vs full

The exact canary command above selects five files covering automation contracts, real component sidebar/settings, connection settings and backend configuration persistence. This run observed 256 passing tests. Use it for a quick representative check and focused feedback; it does not replace affected tests or full proof.

The exact full command selects both Vitest projects without filters, including all architecture files and the unchanged process-heavy tests. It deliberately inherits `NODE_ENV=production`, matching the CI conflict check; existing Vitest configuration sets its test environment to `NODE_ENV=test`. Use full proof for shared contracts, lifecycle/RPC/security changes, runner/helper changes, broad refactors and delivery gates. Preserve existing assertions, contender counts and deadlines.

Capture actual process exits, terminal summaries and JSON reports. Read ordinary passes separately from the existing expected-failure test. A new failure, unexpected skip, flaky acceptance or an unrunnable required method blocks method eligibility. Zero retries and `allowOnly=false` apply to Vitest. Native proof uses zero retries, forbidden only, rejected flaky results and unchanged test deadlines.

## Human vs agent

Humans and agents use the same project runners, isolation wrapper and scope rules. The full command is the primary complete unit/component/integration/architecture check. Native/artifact checks remain required when their subjects change. Agents never update snapshots, relax assertions, retry unchanged failing proof or use live provider credentials for this deterministic matrix.

Humans review the screenshots and reports tied to the exact candidate source. The actual human chose local previews and screenshots for this run, overriding Design's Yodea hosting requirement. Local candidate gates, responsive/theme evidence, exact-revision approval and the final root review-loop still apply. That human choice is distinct from delegated method-eligibility and repair decisions.

## Routine path

Ordinary testing follows its normal project workflow or explicitly selected test skill. Read this record for commands and limitations; it is never a prerequisite or an automatic setup gate. Run affected scopes and required broader checks, capture real outcomes and stop for the owning repair workflow on failure. Preparing a new checkout, changing a method or reopening setup requires its own authorized scope. Do not invoke setup-test merely because source or tools changed.

## Gaps fixed

This setup resume adds only this method record. It adds no test support, dependencies, configuration, production code, assertions, snapshot changes or always-pass markers/hooks. Counts and exits come from executed runner output and machine-readable results.

Accepted prerequisite repairs were committed separately before setup at `f94e25befefe09d77d13fd39ffc96ac16592f7d9`. The packaged hash-route restoration changed `apps/desktop/src/main/application/main-program.ts` and `packages/electron-ipc/main.ts`, with regressions in their existing test files. It ignores only the file URL fragment while retaining exact renderer-file/query, sender/WebContents, main-frame and rejection controls. Cancellation and RPC lifecycle regressions remain strict. The native profile repair changed `apps/desktop/e2e/helpers.ts` and `apps/desktop/test/unit/playwright/effect-test.test.ts`. Each launch owns fresh Electron preference storage, keeps it through that app's theme changes/reloads and closes Electron before cleanup. Production dark defaults/theme semantics were unchanged. These six paths are outside this setup commit's ownership.

## Proof

Proof date is 2026-10-08. Fresh proof ran at the source revision and working directory stated above. Exact execution argv, logs, process exits, JSON reports, source/artifact manifests and qualified reuse are retained in `.tmp/setup-test-f94-proof/`.

| Observation | Actual exit | Result and layer |
| --- | --- | --- |
| Fresh canary | 0 | 5 files, 256 passes, no failures/skips; unit/component/backend integration |
| Fresh full Vitest | 0 | 222 files, 2145 ordinary passes and 1 existing expected failure; reporter counts 2146 passed; no unexpected failures/skips |
| Fresh architecture within full | 0 | 18 files, 115 passes; architecture/static checks |
| Reused lint/typecheck/Knip | 0 each | Bound accepted results; static quality; Knip also executes within the fresh architecture check |
| Reused compiled binary/package certification | 0 each | Real artifact and installed-consumer proof |
| Reused desktop build | 0 | Fresh package from the preceding hash-route repair, not a new build at this commit |
| Reused native desktop | 0 | 8 cases passed; no skipped, unexpected or flaky results; native system layer |
| Reused supplemental packaged reload | 0 | 1 case passed; real reload, read, create and persistence; native system layer |
| Fresh dependency audit | 1 | 1 high and 12 moderate findings; failed independent CI gate |

The fresh full run took 159.326 seconds with test retries disabled. The preceding whole-suite result covered the accepted hash-route repair before the helper/unit-test repair; it had 2,144 ordinary passes and one expected failure. This resume replaces that limited whole-suite binding with fresh full proof of the combined committed source. It does not describe historical checks as rerun.

Reuse verifies all 597 original tracked source hashes against commit blobs and all 126 package artifact hashes. Only the native helper and its unit test differ from the preceding build/full source. Accepted current helper/unit/quality/native proof covers those changes; production/build inputs and package bytes are identical. App.asar SHA256 is `86d35c7caf4e2c48eeeb0262916f0cf668b262599daac46e8f326b8a7a23ed29`. Package version `0.0.0-dev+dc310a13342e` names the earlier baseline. Source/diff/artifact hashes bind the repaired package; it was not rebuilt after the helper repair or at f94e25be.

The reused supplemental viewport is configured 1024x800. Actual page width was 1024, desktop media query active, and measured inner height 801, finite and positive. No exact physical-height equality is claimed. Its Effect-managed finalizer captures evidence before process cleanup on success or failure.

## Limitations

The initial full-suite failure, setup attempts 1/2/3 and failed seven-pass/one-fail native run remain retained. Attempt 1 failed Settings navigation before a reload. Attempt 2 failed a newly added height equality before RPC; that verifier condition was corrected with delegated approval. Attempt 3 reached the unchanged packaged settings URL with new timeOrigin, then failed renderer startup with no port grant within 10000ms. Accepted bounded route repair and unchanged real packaged proof now pass. Viewport corrections do not establish the earlier navigation timeout's cause.

Controlled owned-profile probes demonstrated that reusing Electron preferences can produce the saved dark-startup failure. The failed historical run did not capture its profile/storage value, so its precise historical value remains unknown. No unrelated personal profile contents were read or changed. The original state-root election timeout's cause remains unknown despite subsequent unchanged contender/deadline proof passing.

Fresh audit actual exit 1 remains visible. High `http-cache-semantics` and 12 moderate findings involving `sprintf-js` remain pending for their owning remediation workflow. Installed seroval 1.6.3 and source-map-js 1.2.2 fixes are verified. Rejected http-cache-semantics 4.3.0 is not installed; it failed the prior advisory behavior probes. The observed packaging caller's disabled Got cache does not establish universal mitigation or resolve the advisory. Do not suppress findings or lower the threshold. High-advisory remediation remains an explicit obligation before autonomous-run completion or final PR readiness.

Proof covers the local Linux native environment and deterministic behavior without live provider calls. It does not certify live-provider interoperability, other operating systems, every display environment, load/performance beyond existing tests or the pending assistant/responsibilities feature. The existing GitHub PR must remain draft. Final implementation delivery still requires the root review-loop.

## Ownership

Tracked scope for this transition is only `.expskill/setup-test.md`. No repository dependencies or support scripts are added or changed. Existing scripts/configs/test helpers remain owned by their prior implementation and repair commits.

New ignored evidence lives under `.tmp/setup-test-f94-proof/`. Prior `.tmp/setup-test-proof/`, `.tmp/setup-test-resume-proof/`, `.tmp/correct-proof/`, `.tmp/correct-hash-route-proof/`, `.tmp/correct-profile-proof/`, original preservation manifests and all screenshots/reports remain available. Keep them and the selected checkout until evidence review and safe handoff, as explicitly authorized. This overrides setup-test's default temporary-proof cleanup. Do not commit those artifacts, credentials or personal data.

Preservation ancestry is `72405427 -> ff3c19d8 -> dc310a13 -> f94e25be -> setup record commit`. The 34 original paths were checkpointed once at ff3c19d8. Their original dirty checkout/index/local feature ref remain untouched. Publication uses only a normal fast-forward to remote `feat/automation-workspace`, after checking its expected head, and updates existing draft PR #58 against `develop`. The actual human draft requirement overrides the skill's default non-draft delivery. No protected push, force push, merge, approval, auto-merge or ready transition is authorized.

After delivery, propose a new clean canonical checkout at the verified published head. Do not use the stale original local feature ref as that baseline, or replay checkpointed changes a second time. Creating that checkout and starting parallel Plan/Design require explicit authorization/routing.

## Reopening

Ordinary setup-test invocation reads this tracked record unchanged and stops. Only an explicit setup update, repair or reconfigure request reopens it. An invalid record requires explicit repair intent. Changes to matrix, commands, dependencies, environment, suites, baseline or delivery facts require a revised confirmed proposal and affected proof. Routine testing and source drift do not automatically activate setup-test. Failed required method proof never becomes a ready record; independently failed audit still blocks final PR readiness under the explicit interim eligibility decision above.
