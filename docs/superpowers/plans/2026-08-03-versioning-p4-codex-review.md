# P4 Read-Only Luna Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Review each eligible non-draft pull-request push with read-only Luna and maintain one evidence-backed findings comment with a copy-ready AI repair prompt.

**Architecture:** An unprivileged `pull_request` workflow requests review without secrets, writes, or checkout. A default-branch-controlled `workflow_run` validates the completed request and current same-repository pull request, checks out only trusted default-branch review assets, and presents the current diff as inert prompt data to a command-disabled Codex process. A run-scoped artifact carries structured output to a separate publisher that validates fixed-path UTF-8 data and revalidates the head before every bot-owned comment mutation.

**Tech Stack:** GitHub Actions, `openai/codex-action@v1`, `actions/github-script`, dependency-free Node.js helper, Vitest.

## Global Constraints

- Trigger `opened`, `synchronize`, `reopened`, and `ready_for_review` only in `.github/workflows/codex-review-request.yml`.
- Make the request workflow tokenless with `permissions: {}`; do not check out or execute repository code.
- Run privileged processing only through `.github/workflows/codex-review.yml` on the completed named request workflow from the default branch.
- Before secret use, validate the exact request path, event, conclusion, associated pull request, open state, non-draft state, same repository, and a head SHA matching both the association and workflow run.
- Keep the Codex Action's default write-collaborator authorization; do not set `allow-users`, `allow-bots`, or `allow-bot-users`.
- Run `gpt-5.6-luna` with `effort: max`, Codex CLI `0.146.0`, `permission-profile: ":read-only"`, and `safety-strategy: drop-sudo`.
- Disable `shell_tool` and `unified_exec` through `codex-args`; use ephemeral execution and a dedicated Codex home.
- Do not set the legacy `sandbox` input when `permission-profile` is present.
- Never check out, install, import, or execute pull-request-controlled code. Fetch only the current diff through the GitHub API, reject it above 512 KiB of UTF-8, and place it inside explicit untrusted-data delimiters in a data-only working directory.
- Give the review job only `contents: read` and no pull-request write token.
- Transport output only through `output-file` and a run-scoped artifact, never through an environment variable or generated script source.
- Give the publication job exactly `contents: read`, `issues: write`, and `pull-requests: write`, with no OpenAI secret and no pull-request checkout.
- Load `.github/codex/review-schema.json` from the trusted default branch in both Codex and the helper.
- Reject raw output above 96 KiB, rendered output above 60,000 Unicode code points, malformed structure, and Unicode format controls.
- Manage only marker comments authored by `github-actions[bot]` with user type `Bot`; ignore user-authored markers and retire duplicate managed markers.
- Parse and render before any comment write, and re-fetch the pull-request head immediately before every create or update.
- Keep the check advisory; findings do not fail the workflow.
- No code comments are added.

---

### Task 1: Add structured read-only review and safe sticky publication

**Files:**

- Create: `.github/workflows/codex-review-request.yml`
- Create: `.github/workflows/codex-review.yml`
- Create: `.github/codex/review-schema.json`
- Create: `.github/codex/review-comment.cjs`
- Create: `.github/codex/review-comment.d.cts`
- Create: `test/architecture/codex-review.test.ts`

**Interfaces:**

- Produces: `COMMENT_MARKER = "<!-- expand-codex-review -->"`.
- Produces: `RAW_REVIEW_BYTE_LIMIT = 96 * 1024`.
- Produces: `COMMENT_CODE_POINT_LIMIT = 60_000`.
- Produces: `parseReview(raw): { readonly findings: ReadonlyArray<Finding> }`.
- Produces: `renderRepairPrompt(findings): string`.
- Produces: `renderReviewComment(headSha, findings): string`.
- Produces: `publishReview({ github, owner, repo, issueNumber, expectedHeadSha, raw }): Promise<"created" | "updated" | "retired" | "clean">`.
- Consumes: a fixed UTF-8 artifact file produced by the Codex Action's `output-file` after JSON Schema enforcement.

- [ ] **Step 1: Write failing parser, renderer, ownership, race, and publication tests**

Create `test/architecture/codex-review.test.ts`. Test one valid finding and reject malformed JSON, extra keys, more than 20 findings, unknown severities, unsafe paths, invalid lines and IDs, overlong Unicode code-point strings, control characters, all `\p{Cf}` format characters, and raw UTF-8 data above 96 KiB.

Load `.github/codex/review-schema.json` and prove these exact maxima: rule ID 64, title 120, path 240, evidence 240, impact 160, repair 240, and 20 findings. Build a maximum-size astral-Unicode payload and prove both raw and rendered output remain within their hard caps. Assert renderers visibly neutralize HTML-comment delimiters, triple backticks, mentions, control characters, and format controls without inserting U+200B.

Use a realistic fake GitHub client whose comments include `user.login` and `user.type`. Cover create, update, clean, retirement, adversarial user markers, duplicate bot markers, a stale initial head, a head change after pagination, and a head change between duplicate retirement and canonical update. No mutation may occur without the immediately preceding head read matching the reviewed SHA.

- [ ] **Step 2: Run the helper tests and confirm the red state**

```bash
NODE_ENV=test npm exec -- vitest run test/architecture/codex-review.test.ts
```

Expected: FAIL because the schema, hardened helper behavior, request workflow, and base-controlled processor do not exist.

- [ ] **Step 3: Implement centralized bounded result handling**

Define the finding shape in `review-comment.d.cts`. Put the structured-output shape and exact string/finding bounds only in `review-schema.json`; derive runtime maxima from that file. Measure strings with Unicode code points, measure raw transport with UTF-8 bytes before `JSON.parse`, and reject controls and `\p{Cf}`. Render deterministically by severity, path, line, and rule ID. Reject any rendered comment over 60,000 code points.

Generate one aggregate repair prompt containing only validated IDs, paths, evidence, impacts, and repairs. It must preserve unrelated changes, constrain scope to the findings, require repository rules and regression tests, and request exact verification evidence.

In `publishReview`, validate raw input and render the intended body before any comment write. Read the current head before pagination. Recognize a managed marker only when its body starts with the marker and its author is `github-actions[bot]` with type `Bot`. Ignore adversarial user markers. Re-fetch the head immediately before each mutation. Retire every duplicate managed marker with a marker-free superseded body before updating the canonical findings body. For a clean result, create nothing when no managed marker exists; otherwise retain at most one clean canonical marker and retire extras.

- [ ] **Step 4: Add the unprivileged request workflow**

Create `.github/workflows/codex-review-request.yml` with the exact pull-request trigger types. Give its workflow and job `permissions: {}`, no secrets, no checkout, and one static request step. Gate it on same-repository, non-draft pull requests.

- [ ] **Step 5: Add the default-branch-controlled processor**

Create `.github/workflows/codex-review.yml` with only this trigger:

```yaml
on:
  workflow_run:
    workflows: [Codex review request]
    types: [completed]
```

The review job must validate the exact workflow path, `pull_request` event, successful conclusion, one associated PR, open and non-draft state, same-repository head, and a SHA matching both the workflow run and PR association. Check out only the immutable trusted `${{ github.sha }}` with persisted credentials disabled, and reuse that same ref in the publisher. A static `actions/github-script` step fetches the current diff as text, rejects more than 512 KiB of UTF-8, revalidates the head, and writes a fixed prompt file under `${{ runner.temp }}` with explicit untrusted-data delimiters.

Run `openai/codex-action@v1` with the exact model, effort, pinned CLI, dedicated home, data-only working directory, prompt file, centralized schema file, read-only permission profile, sudo dropping, ephemeral execution, and both command features disabled. Do not configure authorization bypasses or legacy sandboxing. Write the result to a fixed file and upload only that file through `actions/upload-artifact@v4` after Codex.

The publisher downloads the run-scoped artifact to a fixed path, checks out only the default branch for the trusted helper, and invokes a static `actions/github-script` body. That body reads raw UTF-8 with `fs.readFileSync`; model output must never appear in `env`, shell source, or script interpolation. The publisher exposes no OpenAI secret.

The privileged processor first exists after this feature reaches the default branch. The pull request that introduces the request workflow cannot introduce or alter a privileged processor run.

- [ ] **Step 6: Add workflow-architecture assertions**

Parse both workflows with `yaml`. Prove the exact request triggers and permissions; `workflow_run` base control; absence of `pull_request_target`; exact pre-secret validation; default-branch-only checkout; no pull-request ref checkout; data-only diff preparation; static prompt construction; pinned Codex version; disabled command tools; dedicated home and working directory; output schema file; output artifact; absence of result environment transport; exact job permissions; and fixed-path publication.

- [ ] **Step 7: Run P4 verification**

```bash
NODE_ENV=test npm exec -- vitest run test/architecture/codex-review.test.ts
NODE_ENV=test npm run effect:audit
npm run typecheck:all
npm run lint
NODE_ENV=test npm test
git diff --check
```

Expected: all commands PASS. No live API call runs locally; the first eligible workflow run after merge validates the configured `OPENAI_API_KEY` secret.

- [ ] **Step 8: Commit P4**

Stage only the P4 workflows, schema, helper, declaration, tests, exact audit inventory changes, and this plan/design update. Commit with a scoped P4 security-fix subject.

## Operational setup after merge

Add `OPENAI_API_KEY` under repository Settings → Secrets and variables → Actions → Repository secrets. No interactive Codex or ChatGPT login is required. The request workflow remains skipped for fork and draft pull requests. The privileged workflow runs only from the default branch and still applies the Codex Action's default write-collaborator authorization.

## Current sources

- [Codex GitHub Action](https://learn.chatgpt.com/docs/github-action)
- [Codex Action inputs](https://github.com/openai/codex-action/blob/main/action.yml)
- [Codex Action security guidance](https://github.com/openai/codex-action/blob/main/docs/security.md)
- [GitHub `workflow_run` security guidance](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run)
- [GPT-5.6 Luna guidance](https://developers.openai.com/api/docs/guides/model-guidance?model=gpt-5.6-luna)
