# Final Task 2 second review fix

**Base:** `097d1c7`

Resolve all four Important findings with strict TDD.

1. Complete child-launch parsing:
- Parse imports/aliases/namespaces for Effect ChildProcess and every Node `child_process` launch API (`spawn`, `exec`, `execFile`, `fork`, sync variants as applicable), including `node:` and bare imports, require/destructure aliases.
- Resolve direct command/path arguments, arrays/options, local constants, imported constants, and local/imported wrapper helpers whose parameters flow to supported launch APIs. Reject unresolved first-party launch targets fail-closed rather than silently omit.
- Preserve every source-ordered occurrence. Add synthetic actual-collector cases for each form, aliases, wrappers, repeated/direct commands, child-only target, missing inventory.

2. Sole fixture use:
- Route the current live `binary-smoke.test.ts` fixture launch through the same sole production command helper or a non-launching test seam; only one parsed ChildProcess invocation may resolve JOB_CONTROL_FIXTURE repository-wide.
- Remove synthesized fixture observation and global skip. Independently discover the exact sole consumer occurrence across all tracked callers; fail if 0 or >1. Live inventory link must come from it.

3. Complete preload proof:
- Reject every `node:` specifier categorically for static/side-effect/dynamic/require/export/import-equals forms.
- For bare Node builtins, use a complete authoritative builtin set (including `test`, `sqlite`, subpaths and prefixes), acquired through one exact registered host adapter if needed. Reject Effect packages and Node platform services through aliases/forms.

4. Adversarial integration tests must invoke the actual collector and fail before inventory comparison for omitted native/alias/wrapper launch forms, second fixture consumer, and node:test/node:sqlite across syntax forms.

Run all gates, update report, commit `fix: close executable discovery gaps`.

# Fix wave implementation report

Status: DONE

## Changes
- `scripts/effect-executable-inventory.ts`: added repository-wide AST launch analysis for Effect and all Node child-process launch APIs, namespace/import/require/destructure/import-equals/local aliases, local and imported constants, and local/imported parameter-flow wrappers; unresolved first-party-looking targets fail closed.
- `scripts/effect-executable-inventory.ts`: independently resolves the fixture launch API occurrence across every tracked caller, requires exactly one, and derives the live host invocation link from that occurrence.
- `scripts/effect-executable-inventory.ts`: categorically rejects every `node:` preload specifier and acquires the authoritative bare builtin set through the collector's existing exact ChildProcess host adapter.
- `scripts/binary-smoke.ts` and `scripts/binary-smoke.test.ts`: routed the remaining live test fixture signal launch through the sole production command helper.
- `test/architecture/effect-executable-inventory.test.ts`: added actual-collector synthetic repositories covering all Effect and native launch APIs, bare and `node:` imports, aliases, namespaces, require/destructure/import-equals forms, local/imported constants and wrappers, a second fixture consumer, and `node:test`/`node:sqlite` plus bare builtin syntax forms.

## Test or validation evidence
- Mode: TDD
- RED: with the new collector tests and base `097d1c7` production collector, `npm exec -- vitest run test/architecture/effect-executable-inventory.test.ts -t "native, aliased, and wrapped|second tracked caller|exhaustive Node builtin preload"` failed 9 tests, exit 1. Only the direct Effect case was discovered; the second fixture caller was accepted; all required builtin preload forms were accepted.
- RED: `npm exec -- vitest run test/architecture/effect-executable-inventory.test.ts -t "native, aliased, and wrapped"` failed, exit 1, after adding require-property, require-destructure namespace alias, and import-equals cases.
- GREEN: `npm exec -- vitest run scripts/effect-executable-inventory.test.ts test/architecture/effect-executable-inventory.test.ts scripts/binary-smoke.test.ts` passed 3 files and 85 tests, exit 0.
- Covering test files: `scripts/effect-executable-inventory.test.ts`, `test/architecture/effect-executable-inventory.test.ts`, and `scripts/binary-smoke.test.ts`.

## Task gate
- `npm ci`: passed with no tracked changes, exit 0.
- `npm ci --prefix docs/architecture`: passed, exit 0.
- `npm run agents:check`: synchronized, exit 0.
- Focused covering command: 3 files and 85 tests passed, exit 0.
- `npm run effect:audit`: 0 blocking findings, 75 advisories, 280 candidates, migration-debt=0; executable inventory validation passed, exit 0.
- `npm run effect:grep > /tmp/expand-effect-final-task-2-second-fix-grep.txt`: passed, exit 0.
- `npm run effect:launchers`: passed, exit 0.
- `npm run lint`, `npm run typecheck:all`, `npm run arch`, and `npm run knip`: passed; architecture checked 189 modules and 624 dependencies, exit 0 each.
- `npm run test`: full suite passed, exit 0.
- `npm run bench:selfcheck`: `selfcheck OK`, exit 0.
- `npm run bench:events -- --smoke`: all six rows passed, exit 0.
- `npm run build`, `npm run cert:cli:build`, `npm run build:desktop`, and `npm run cert:packages`: passed, exit 0 each.
- `xvfb-run -a npm run e2e:desktop`: 6 tests passed, exit 0.
- Exact Git mode and SHA-256 checks: both retained host files are mode `100755` and both hashes match the inventory, exit 0.
- Package residue scan: no residue, exit 0.
- Added-comment scan: no added TypeScript comments, exit 0.
- Production/model migration-launcher scan: no residue, exit 0.
- `git diff --check`: passed, exit 0.

## Commits
- `HEAD` `fix: close executable discovery gaps` (exact SHA returned in the completion handoff)

## Self-review
- Launch API coverage, aliases, constants, wrappers, exact occurrences, and fail-closed first-party resolution: satisfied by actual-collector tests.
- Exactly one independently discovered fixture consumer and live link derived from it: satisfied; the second-consumer synthetic repository fails during discovery.
- Exhaustive `node:` and authoritative bare builtin preload rejection across all parsed syntax forms: satisfied.
- Actual-collector adversarial tests fail before inventory comparison for every required category: satisfied.
- Final Task 2 scope only, no dependencies, no comments, no updater/generator, zero migration debt: satisfied.

## Concerns
- None