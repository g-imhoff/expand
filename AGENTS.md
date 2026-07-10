# Agent instructions

## Code comments

- Do not write code comments unless the user explicitly asks for them. If a comment would be genuinely valuable at one specific place, propose it and ask — never add it unprompted.
- When asked, doc comments are TSDoc (`/** … */`) and must stay TypeDoc-compatible: no docgen pipeline exists yet (deliberate — adopt TypeDoc + typedoc-plugin-markdown emitting into `docs/api/` if one is ever added). Shape: one-line summary first (that's the LSP hover), contract in `@remarks`, `@param name - description` in signature order, `@returns`, `@defaultValue` on defaulted options, `{@link}` cross-references, titled `@example` with ```ts fences. House-style reference: `apps/server/db/event-store.ts`.

## Agent orchestration

Use the project-scoped named agent whenever the work matches one of these roles:

| Agent | Use for | Tracked-tree access |
|---|---|---|
| `code-reviewer` | Broad major-feature or final whole-branch review | Read-only |
| `task-reviewer` | One Superpowers task's spec-compliance and quality gate | Read-only |
| `desktop-tester` | Built Electron renderer certification with CLI cross-checks | No source edits; build and temporary artifacts only |
| `manual-tester` | Compiled CLI and backend lifecycle certification | No source edits; build and temporary artifacts only |
| `tdd-implementer` | One plan task or one consolidated review-fix wave | Assigned source edits and commit only |
| `researcher` | Current external research or bounded codebase investigation | Read-only |
| `debugger` | Reproduction and root-cause diagnosis before a fix | No tracked source edits; temporary diagnostics only |

- Select the named agent type and do not pass model or reasoning overrides; the checked-in agent definition owns those defaults.
- Do not use a generic worker when a matching named agent exists.
- Never dispatch parallel tracked-tree writers. Read-only agents may run concurrently only when their scopes are independent.
- Keep brainstorming, implementation planning, worktree creation, review-feedback adjudication, fresh final verification, and branch completion in the controller using the applicable Superpowers skill.
- Use a fresh `tdd-implementer` for each task and each consolidated fix wave, a fresh `task-reviewer` after each implementation or fix wave, and `code-reviewer` once across the complete branch.
- Send all Critical and Important task-review findings to one fresh `tdd-implementer` fix wave, then repeat the same task-review gate before proceeding.
- Treat subagent reports as evidence, not authority: the controller independently runs the completion commands required by `superpowers:verification-before-completion`.
- Treat checked-in model, effort, and sandbox fields as deterministic defaults. Higher-priority runtime or administrator controls can supersede them; inspect the spawned task details when runtime confirmation matters.
- Workers do not spawn workers. Direct delegation depth is one.
- Do not add permanent `orchestrator`, `planner`, `fixer`, `verifier`, `worktree-manager`, or `branch-finisher` agents; those responsibilities stay with the controller and Superpowers skills.
- After agent or project configuration changes, start a fresh Codex task so project agents and their tool schema are rediscovered.
