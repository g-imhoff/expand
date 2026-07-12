# Close architectural review gaps

- **Date:** 2026-07-12
- **Status:** Approved for autonomous implementation
- **Goal:** Resolve the five confirmed agent, architecture, test-collection, and compiled-runtime certification gaps without weakening the global `--data-dir` contract.

## Decisions

1. Keep `.claude/agents/*.md` as the canonical agent definitions and regenerate every `.codex/agents/*.toml` mirror from them.
2. Make repository synchronization an executable gate in three places: a real-tree synchronizer test, the pre-commit hook, and CI.
3. Define I-2 as one backend `AppLayer` per selected state root and I-3 as one endpoint file per selected state root. Distinct data directories may intentionally host independent backends; frontends selecting the same directory must converge on one backend, and manually launched same-root servers must not bypass that ownership.
4. Keep the test-colocation allowance for direct `scripts/*.test.tsx` files and add the missing Vitest collection glob.
5. Preserve the existing directly-owned server smoke for CRUD and add a compiled CLI auto-spawn phase that proves sibling-server resolution and I-4 shutdown.

## Agent synchronization

`scripts/sync-agents.test.ts` will check the actual repository root in addition to temporary fixtures. The four stale Codex files will be regenerated, restoring the pinned model, effort, sandbox, and canonical prompts. `.githooks/pre-commit` and `.github/workflows/ci.yml` will invoke `bun run agents:check` explicitly so drift fails before commit and in CI.

## State-root ownership contract

State-root identity is the normalized absolute `dataDir` produced by `makeAppContext`. `docs/architecture/BOUNDARIES.md`, `docs/architecture/expand.c4`, `REVIEW.md`, and `packages/client-ts/ARCHITECTURE.md` will consistently use “one AppLayer per state root” and “one discovery file per state root.” A new ADR will record that multiple roots per machine are intentional and that historical machine-wide wording is superseded.

The server will hold a lifetime ownership file distinct from the client's short-lived spawn lock. Default-home migration runs first so lock creation cannot pre-create the nested migration target; ownership is then acquired before logger, database, endpoint, or `AppLayer` startup. Acquisition uses exclusive creation, rejects a live same-root owner, recovers a dead owner, and records a unique token. Release removes the file only when that token still matches, preventing one process from deleting a replacement owner's lock.

Architecture and integration tests will pin the documentation and runtime rule. State-root lock tests will cover same-root rejection, different-root coexistence, stale recovery, and ownership-safe release. Client discovery tests will prove that concurrent clients sharing one data directory cause one spawn while two different directories spawn independently.

## Script test collection

Vitest will collect both `scripts/**/*.test.ts` and `scripts/**/*.test.tsx`. The colocation fitness test will read the configured globs and fail if its script-test allowance and Vitest collection diverge again.

## Compiled auto-spawn certification

The smoke harness will run at least one `./dist/expand --data-dir ...` command without prestarting `dist/expand-server`. It will enable Bash job control, clear inherited `EXPAND_BACKEND_CMD`, and launch the CLI inside an owned guardian subshell. The spawned backend is unreferenced but not detached, so it inherits the guardian job's process group.

The guardian starts an endpoint monitor before the foreground CLI. The monitor reads the advertised PID from `server.json` while it exists, records that PID's process group as evidence, and never signals it. After recording the CLI status, the guardian remains alive until the controller creates a release file, keeping a stable job/process-group owner throughout observation.

The parent harness will:

- capture the stable Bash job spec immediately;
- require the monitor's endpoint-derived backend PID and process group to match the owned guardian group;
- validate the CLI response and endpoint lifecycle;
- wait for I-4 to remove the endpoint and spawn lock and for the backend PID to leave the owned process group;
- release and reap the guardian only after those conditions hold;
- signal only the stable job spec with bounded TERM/KILL escalation on failure; and
- preserve the data directory whenever ownership or shutdown cannot be proven.

The existing direct-server CRUD smoke remains unchanged in purpose. Focused shell-harness tests will pin auto-spawn presence, group-membership validation, bounded cleanup, and the prohibition on process-name matching.

## Verification

Completion requires:

- focused red/green tests for each gap;
- `bun run agents:check`;
- focused synchronizer, architecture, client discovery, and smoke tests;
- `bun run lint`;
- `bun run typecheck:all`;
- `bun run test`;
- `bun run cert:cli:build`;
- `git diff --check`; and
- a final read-only branch review.
