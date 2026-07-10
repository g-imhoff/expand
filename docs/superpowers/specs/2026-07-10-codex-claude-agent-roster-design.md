# Deterministic Codex and Claude agent roster

- **Date:** 2026-07-10
- **Status:** Approved (design) — pending implementation plan
- **Goal:** Give Expand a project-scoped, auditable roster of specialized Codex and Claude agents whose model and reasoning settings are explicit, whose responsibilities align with Superpowers, and whose generated mirrors cannot silently drift.

## Problem

Expand has four project-specific Claude agents, but no corresponding Codex
agents. Codex can therefore delegate work without making the selected model and
reasoning level obvious, and ad-hoc delegation does not reliably preserve the
project-specific review, TDD, desktop, and CLI testing contracts.

The current Claude tester definitions also contain stale assumptions. In
particular, they use `EXPAND_HOME` as an isolation control even though the
current runtime derives its data directory from `--data-dir` or, by default,
`~/.expand/<channel>`. Running those instructions unchanged can connect to or
modify real user state. The desktop instructions also encode UI defects and
source paths as permanent facts even after the implementation changes.

The solution must work with the Superpowers workflow rather than duplicating
each skill as another permanent agent. Brainstorming, planning, worktree setup,
review reception, final verification, and branch integration remain controller
responsibilities. Permanent agents are reserved for work that benefits from a
fresh context, a specialized prompt, or an explicit model tier.

## Decisions

1. Keep all agents project-scoped and checked into this repository. Do not
   install copies under `~/.codex/agents` or `~/.claude/agents`.
2. Treat `.claude/agents/*.md` as the human-edited source for agent identity,
   description, tool access, Claude model, Claude effort, and behavioral prompt.
3. Generate and commit matching `.codex/agents/*.toml` files. Generated files
   carry the same identity, description, and behavioral prompt plus the Codex
   model, reasoning effort, and sandbox default.
4. Pin the Codex controller for this project to GPT-5.6 Sol at Ultra effort.
5. Keep delegation one level deep. The controller may spawn direct workers;
   workers do not recursively spawn more agents.
6. Never run more than one tracked-tree writer at a time. Read-only research,
   diagnosis, and review may run concurrently when their scopes are independent.
7. Replace the proposed `verifier` agent with a `task-reviewer`. Superpowers
   requires a distinct per-task spec-and-quality gate, while final completion
   verification must be performed afresh by the controller and cannot be
   delegated as authoritative evidence.

## Roster and exact model policy

| Agent | Responsibility | Codex | Claude | Tracked-tree policy |
|---|---|---|---|---|
| `code-reviewer` | Broad major-feature or whole-branch review covering correctness, security, compatibility, architecture, and test gaps | `gpt-5.6-sol`, `ultra` | `claude-fable-5`, `xhigh` | Read-only |
| `task-reviewer` | Superpowers per-task gate with separate spec-compliance and code-quality verdicts | `gpt-5.6-sol`, `ultra` | `claude-fable-5`, `xhigh` | Read-only |
| `desktop-tester` | Real Electron renderer certification with backend cross-checks | `gpt-5.6-sol`, `medium` | `claude-opus-4-8`, `xhigh` | No source edits; build and temporary artifacts allowed |
| `manual-tester` | Compiled CLI and backend-lifecycle certification | `gpt-5.6-sol`, `medium` | `claude-opus-4-8`, `xhigh` | No source edits; build and temporary artifacts allowed |
| `tdd-implementer` | One implementation task or one review-fix wave using strict red-green-refactor | `gpt-5.6-sol`, `medium` | `claude-opus-4-8`, `xhigh` | May edit and commit the assigned scope |
| `researcher` | Current external research and focused codebase investigation with source attribution | `gpt-5.6-sol`, `medium` | `claude-opus-4-8`, `xhigh` | Read-only |
| `debugger` | Reproduce failures, trace root cause, test one hypothesis at a time, and hand off a minimal fix target | `gpt-5.6-sol`, `medium` | `claude-opus-4-8`, `xhigh` | No tracked source edits; diagnostic and temporary artifacts allowed |

Both review roles use the most capable configured models because their output is
a quality gate. All other roles use Sol Medium on Codex. Claude workers remain
at `xhigh` by explicit user choice even when their work is routine.

The model fields are deterministic defaults, not an override of higher-priority
runtime controls. A Claude `CLAUDE_CODE_SUBAGENT_MODEL` environment variable or
an explicit per-invocation model can supersede Claude frontmatter. Codex spawn
calls can likewise provide explicit overrides, and live parent permission
settings can supersede an agent's sandbox default. Project instructions will
therefore require the controller to select the named agent type and omit
per-call model and reasoning overrides. Users can inspect the spawned thread's
details when they need runtime confirmation.

## Controller configuration and orchestration

Add `.codex/config.toml` with these project defaults:

- `model = "gpt-5.6-sol"`
- `model_reasoning_effort = "ultra"`
- `features.multi_agent = true`
- `agents.max_threads = 6`
- `agents.max_depth = 1`

The project must be trusted for Codex to load this layer. A fresh Codex task is
required after installation so the client rediscovers the project agents and
their tool schema. Existing running agent threads are not retroactively
reconfigured.

Extend `AGENTS.md` with the orchestration contract:

- Use a named project agent whenever one of the seven responsibilities matches.
- Do not pass model or reasoning overrides for a named project agent.
- Do not use a generic worker when a matching named agent exists.
- Do not dispatch parallel tracked-tree writers.
- Keep planning, worktree management, final verification, and branch completion
  in the controller.

The normal Superpowers development sequence is:

1. The controller uses brainstorming and writing-plans.
2. The controller uses the worktree skill and verifies a clean baseline.
3. A fresh `tdd-implementer` performs one plan task and writes its report.
4. A fresh `task-reviewer` reads the task brief, implementation report, and
   review package. It returns independent spec-compliance and task-quality
   verdicts.
5. Critical or Important findings go to a fresh `tdd-implementer` fix wave,
   followed by the same task-review gate again.
6. After every task is accepted, `code-reviewer` performs the broad branch
   review using the most capable tier.
7. The controller independently runs the fresh verification commands required
   by Superpowers before making any completion claim.
8. The controller uses the finishing-a-development-branch skill for the user's
   integration choice.

No permanent `orchestrator`, `planner`, `fixer`, `verifier`, `worktree-manager`,
or `branch-finisher` is added. Those would either duplicate a Superpowers skill,
split decisions away from the controller that owns their context, or delegate a
user-facing integration decision that must remain with the controller.

## Agent contracts

### `code-reviewer`

This agent performs the final or major-feature review, not the per-task gate. It
receives requirements and a branch review package, stays read-only, and reports
strengths plus Critical, Important, and Minor findings with file-and-line
evidence. Its verdict is `Ready`, `Ready with fixes`, or `Not ready`. It covers
Expand's documented boundaries, Effect v4 constraints, compatibility behavior,
security, process lifecycle, error handling, and missing tests. It does not fix
findings and does not replace the controller's fresh verification run.

### `task-reviewer`

This agent implements the Superpowers task-reviewer contract. It reads exactly
one task brief, the implementer's report, the global constraints, and the diff
package. It does not crawl the entire repository or rerun a full suite that the
implementer already reported. Its output begins with a spec-compliance verdict,
then strengths, severity-ranked issues, and a separate task-quality verdict.
Anything that cannot be established from the task diff is reported explicitly
as unverified for the controller to resolve.

### `tdd-implementer`

This is the only general source-writing agent. Each invocation handles exactly
one plan task or one consolidated review-fix wave. It must read the task brief,
ask before guessing, follow strict red-green-refactor, run focused tests while
iterating, run the plan's required task gate before committing, self-review,
write the detailed report file, and return one of `DONE`,
`DONE_WITH_CONCERNS`, `NEEDS_CONTEXT`, or `BLOCKED`. It never broadens scope or
runs concurrently with another tracked-tree writer.

### `researcher`

This agent handles external research and bounded codebase exploration. For
technical questions it prefers current primary sources and distinguishes facts
from inference. It returns a concise recommendation, alternatives, material
trade-offs, dates where freshness matters, and direct source links. It does not
modify the repository or turn research into an implementation without a new
delegation.

### `debugger`

This agent follows Superpowers systematic debugging: reproduce, inspect full
errors, check recent changes, trace component boundaries, compare with working
patterns, state one hypothesis, and test it minimally. It must not propose a fix
before identifying a supported root cause. It returns reproduction steps,
evidence, the confirmed or best-supported root cause, rejected hypotheses, and
the smallest regression test and fix target for a later `tdd-implementer`. If
tracked diagnostic instrumentation is necessary, it reports
`NEEDS_INSTRUMENTATION` rather than editing product code itself.

### `desktop-tester`

This agent certifies the built Electron application through the real renderer
and cross-checks backend truth through the CLI. Stable selectors and launch
commands may be documented, but it verifies them at startup and reports selector
drift instead of treating old observations as permanent facts. It exercises the
current create, rename, directory, metadata, archive, restore, delete, and
command-palette flows that the UI actually exposes. A missing expected flow is a
failure or explicit product gap, not an undocumented CLI workaround.

### `manual-tester`

This agent certifies the compiled CLI, structured envelopes, project operations,
backend reuse, endpoint advertisement, authentication boundary, and final-client
shutdown. It reports exact commands, exit codes, parsed observations, invariant
results, and cleanup status in structured JSON. It does not edit product code to
make the certification pass.

## Tester isolation and process safety

Neither tester may use `EXPAND_HOME` as an isolation mechanism. The current
runtime reads `--data-dir`, and the client adapter propagates that directory to
the spawned backend. Each tester must:

1. Create a unique directory with `mktemp -d` and resolve its absolute path.
2. Refuse to proceed if the path is empty, is the repository root, is the user's
   home, is under `~/.expand`, or is not the exact temporary directory it
   created.
3. Pass `--data-dir <temporary-directory>` to every Expand CLI invocation.
4. Launch Electron with the same `--data-dir` argument so the renderer client,
   spawned backend, and CLI assertions share one isolated endpoint and database.
5. Read `server.json` only from that directory and record the advertised backend
   PID before making lifecycle assertions.
6. Track every process the harness starts. Cleanup may terminate only those
   recorded PIDs and may remove only the exact temporary directories created by
   the harness.
7. Emit `BLOCKED_UNSAFE_ISOLATION` before any mutation if these checks cannot be
   established.

The agents must not invoke `scripts/binary-smoke.sh` while it still relies on
`EXPAND_HOME`; correcting that separate script is outside this agent-roster
change. The agent procedures instead build the binaries and invoke them directly
with `--data-dir`.

## Canonical source and generated Codex files

The seven `.claude/agents/*.md` files are the editable definitions. Every file
has YAML frontmatter containing at least `name`, `description`, `tools`, `model`,
and `effort`, followed by the behavioral prompt as Markdown. The two reviewers
pin `claude-fable-5`; the remaining five pin `claude-opus-4-8`; every file pins
`effort: xhigh`.

Add `scripts/sync-agents.ts`. It contains the exact expected roster and Codex
model/sandbox mapping, parses Claude frontmatter with `Bun.YAML.parse`, validates
the prompt body, and renders one deterministic TOML file per agent. Each Codex
file contains, in stable order:

- `name`
- `description`
- `model`
- `model_reasoning_effort`
- `sandbox_mode`
- multiline-literal `developer_instructions`

Reviewers and the researcher default to `read-only`; the implementer, testers,
and debugger default to `workspace-write`. Behavioral instructions remain the
primary restriction on tracked-tree edits, and active parent permission choices
may supersede these defaults.

The synchronizer rejects a prompt containing TOML's multiline-literal terminator
rather than emitting ambiguous TOML. It also rejects missing required fields,
duplicate names, filename/name mismatches, unexpected or missing roster entries,
wrong Claude model assignments, wrong Claude effort, or an absent prompt body.

Two package scripts expose the workflow:

- `agents:sync` updates the seven expected `.codex/agents/*.toml` files.
- `agents:check` renders in memory, compares byte-for-byte with the checked-in
  files, and exits nonzero with the stale paths.

Neither mode silently deletes an unexpected TOML file. An unexpected file is an
error requiring an explicit roster decision, which prevents the synchronizer
from deleting a manually created agent.

## Validation and acceptance criteria

The synchronizer is implemented with tests first. Focused tests cover:

- valid YAML frontmatter and Markdown body extraction;
- every missing required field and an empty prompt;
- filename/name mismatch, duplicate names, and roster mismatch;
- exact Claude and Codex model/effort mappings;
- deterministic TOML rendering and successful `Bun.TOML.parse` of every output;
- safe rejection of the multiline-literal terminator;
- check-mode success on synchronized files and failure on a modified, missing,
  or unexpected file;
- write mode updating only expected generated files.

Completion requires fresh successful runs of:

- the focused synchronizer test;
- `bun run agents:sync` followed by `bun run agents:check`;
- YAML parsing of every Claude definition;
- TOML parsing of `.codex/config.toml` and every Codex definition;
- `codex debug models`, confirming `gpt-5.6-sol` supports `medium` and `ultra`;
- a read-only Codex app-server/config startup from the project root with no
  malformed-agent or project-config warning;
- `claude doctor`, with any unrelated machine warning separated from agent-file
  validation;
- `bun run typecheck:all` and `bun run test`;
- `git diff --check`.

Validation does not make paid inference calls. After implementation, the user
starts a fresh Codex task and can inspect one spawned review agent and one
non-review agent in the activity panel to confirm the displayed runtime model
and effort. That manual observation verifies client presentation and any
machine-level override; it is not a substitute for the automated configuration
checks.

## Non-goals

- Installing or changing user-global agents.
- Pinning the Claude main-session model.
- Creating one agent for every Superpowers skill.
- Allowing recursive subagent delegation.
- Running multiple implementation agents against the same worktree in parallel.
- Preventing an administrator, environment variable, or explicit invocation
  from applying a higher-precedence model or permission override.
- Making paid model calls as part of configuration validation.
- Fixing `scripts/binary-smoke.sh`, the desktop product, the CLI update system,
  or the desktop/backend compatibility design in this change.
