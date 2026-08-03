# Versioning and Codex PR Review Design

Date: 2026-08-03

## Summary

Expand will derive one product release identity from an exact Git tag, keep compatibility epochs beside the contracts they govern, add explicit database and event migrations, enforce the mechanical rules in CI, and add an advisory read-only Codex review to every push on a trusted non-draft pull request.

This design removes false release sources such as the CLI's hard-coded `0.0.0`. It does not replace several compatibility domains with one global counter. A product release, a CLI JSON envelope, a client/server protocol, a stored event payload, a database schema, and a projection cache have different compatibility lifecycles. Coupling them would make routine changes trigger unrelated migrations and would hide which contract actually changed.

`docs/architecture/VERSIONING.md` will be the central index for every version-like value. Each executable value will remain with its semantic owner.

## Goals

- Make an exact `v<SemVer>` Git tag the sole authority for a release version.
- Embed the same resolved product version in CLI, server, desktop, and publishable package artifacts.
- Remove runtime Git access and hard-coded application release values.
- Give SQLite schema changes an ordered, transactional migration boundary.
- Give stored event payloads explicit per-event revisions and sequential upcasters.
- Make all version domains and bump rules discoverable from one document.
- Enforce deterministic versioning rules in the existing CI suite.
- Review every eligible pull-request push with `gpt-5.6-luna` at `max` reasoning in a read-only job.
- Post one actionable pull-request comment when the review finds issues, including a copy-ready repair prompt for an AI coding agent.

## Non-goals

- Automatic tag creation, npm publication, deployment, or release-note generation.
- Independent CLI, server, and desktop release trains.
- Exposing storage revisions through domain events or RPC.
- Replacing generated projection fold hashes with a manual version.
- Making the Codex review a required merge gate in its first iteration.
- Sending repository secrets to fork pull requests.

## Decisions and rejected alternatives

### One release identity, several compatibility domains

The chosen design has one product release version and several narrowly owned compatibility values. The central document records all of them, but no runtime registry imports unrelated contracts into one module.

A single global compatibility counter was rejected because a CLI output change should not invalidate persisted events, force clients to reject a compatible server, or rebuild projections. Reading package manifests or Git at runtime was rejected because installed artifacts may not contain a repository and because each process could observe a different value.

### Keep the CLI envelope app-owned

The CLI JSON envelope is a unilateral stdout format. It is not a client/server contract. It will remain under `apps/cli/cli/contract`, consistent with `APP_STRUCTURE.md` and the earlier boundary decision that moved it out of `packages/contracts`.

The standalone `apps/cli/cli/contract/version.ts` adds indirection without adding ownership. P2 will remove it and define `ENVELOPE_VERSION` in the envelope module used by all CLI envelope schemas.

### Use Effect SQL migrations

The server will use `effect/unstable/sql/Migrator` and the existing Effect SQL client. A hand-written migration loop and continued `CREATE TABLE IF NOT EXISTS` calls in store constructors were rejected. The former duplicates transaction and ledger behavior; the latter provides no ordered upgrade path.

### Keep event revisions in persistence

An `event_revision` database column will carry the stored payload revision. Domain events, `SequencedEvent`, and RPC schemas will continue to represent only the current domain shape. Wrapping every public event payload in storage metadata was rejected because it would couple persistence compatibility to transport compatibility.

### Use deterministic checks before semantic review

CI tests will enforce properties that can be proved mechanically. Luna will review semantic changes that need judgment, such as whether a changed contract is breaking. Asking a model to replace deterministic checks was rejected because review output is advisory and probabilistic.

## Version-domain inventory

| Domain | Authority | Current value | Consumer | Change rule |
| --- | --- | --- | --- | --- |
| Product release | Exact `v<SemVer>` tag at the built commit | No release tag exists yet | CLI, server, desktop, staged packages | New release tag |
| Tracked workspace manifests | Private development metadata | `0.0.0` sentinels | npm and Electron development tooling | Never used as a release input; staging replaces the sentinel in copied manifests |
| CLI JSON envelope | CLI envelope contract | `expand/v1` | CLI JSON consumers | Bump for a breaking output-shape change |
| Backend protocol | Shared RPC compatibility module | `2` | Server advertisement and client discovery | Bump when old clients and new servers cannot communicate safely |
| SQLite schema | Ordered server migrations | Baseline migration to be introduced | Server persistence | Add the next migration; never edit an applied migration |
| Stored event payload | Per-event revision registry | `ProjectCreated` becomes revision `2`; existing event tags start at `1` | Event append and replay | Bump only the changed event tag and add every intermediate upcaster |
| Projection cache | Generated fold source hash | Generated values | Projection restore and rebuild | Regenerate from fold implementation; mismatches rebuild caches |
| Audit inventory formats | Owning script schema | `1` | Repository tooling | Bump only when that tool's stored format changes |
| Benchmark seed cache | Benchmark seed generator | `1` | Benchmark database cache | Bump when generated benchmark bytes or meaning change |
| Internal command metadata | Owning development command | Development-only sentinel | Effect CLI help for repository tools | Independent of product release unless the command ships as a product artifact |
| Runtime and dependency pins | `.node-version`, package manifests, and lockfile | Independently pinned | Build and documentation toolchains | Update through their existing lockstep and architecture checks |
| PR review model | Trusted workflow definition | `gpt-5.6-luna`, `max` | Advisory pull-request review | Change only through reviewed workflow configuration |

Tests may repeat expected public values as compatibility oracles. Those literals are assertions, not production sources of truth.

## P0: database migrations and event upcasting

### Migration boundary

Create an app-owned migration module under `apps/server/migrations`. It will expose a `DatabaseReady` capability whose layer:

1. Acquires the configured `SqlClient`.
2. Runs the ordered Effect SQL migration registry in a transaction.
3. Fails server startup if a migration fails or the database reports an unsupported future state.
4. Provides `DatabaseReady` only after the migration completes.

`EventStore` and `ProjectionStateStore` will require both `SqlClient` and `DatabaseReady`. Their constructors will stop creating tables or indexes. This dependency makes migration ordering explicit even when the composition layer builds services concurrently.

The first migration must support both a new database and the current legacy layout. It will:

- Create `events`, its stream index, and `projection_state` when absent.
- Inspect an existing `events` table and add `event_revision INTEGER NOT NULL DEFAULT 1` when absent.
- Preserve all existing rows and projection state.
- Let the Effect migrator record the successful migration only after the transaction commits.

The migration tests will start from empty, current legacy, partially invalid, and already migrated databases. They will prove idempotence, rollback, retry, data preservation, and fail-closed handling of future migration records.

### Event revision registry

Create one server-owned registry under `apps/server/migrations/events.ts`. For every event tag it will define:

- The current stored revision.
- A contiguous map from revision `n` to `n + 1`.
- A pure upcaster that accepts unknown JSON and returns unknown JSON or a typed migration error.

New writes will look up the current revision and persist it with the encoded payload. Replay will read the tag, revision, payload, and row context; reject unknown tags and future revisions; apply each intermediate upcaster; then decode the result through `DomainEventFromJson`.

`ProjectCreated` is the first production path. Revision `1` represents the payload before `directory`; revision `2` preserves an existing directory or supplies `directory: null`. Existing rows receive revision `1` during the database migration and therefore pass through this upcaster.

Migration failures will report sequence, stream, event tag, stored revision, target revision, and the failed step. They will stop replay rather than skip or partially reinterpret history.

### P0 acceptance criteria

- Store construction cannot access a database before migrations complete.
- The server opens a legacy database without losing events or projection state.
- New rows contain the current revision for their event tag.
- A revision-1 `ProjectCreated` replays as the current domain event.
- Unknown future revisions and missing upcaster steps fail with row context.
- A failed database migration leaves no successful ledger entry or partial schema change.
- Projection rebuild and RPC output remain equivalent after upcasting.

## P1: Git-derived product version

### Resolver

Create a pure, testable resolver in `scripts/app-version.ts`. Its production adapter will inspect tags only during build or publish staging.

An exact tag at `HEAD` matching `v<valid SemVer>` resolves to the SemVer text without `v`. A release operation fails on a missing, malformed, conflicting, or non-HEAD release tag. An ordinary untagged development build resolves to `0.0.0-dev+<short-sha>`, or `0.0.0-dev` when Git metadata is unavailable.

The resolver will not treat an environment variable, package manifest, or runtime Git command as an independent authority. CI may transport the value resolved from `github.ref_name` into an isolated build step, but that value must pass the same parser and tagged-commit validation.

### Artifact injection

Declare `__EXPAND_VERSION__` with the existing build globals and expose a small `appVersion`/build-info reader from `packages/contracts`. The name describes shared build metadata, not a protocol epoch.

- `scripts/build.ts` resolves once and supplies the same define to the CLI and server esbuild entries.
- `scripts/desktop-command.ts` resolves once and transports the value to `electron.vite.config.ts`, which defines it for the desktop bundles.
- The CLI passes the injected value to `Command.run`, so `expand --version` reports the release tag.
- Server and desktop startup diagnostics consume the same build-info value without adding it to the endpoint protocol.
- Publish staging requires a release resolution and writes that value to the staged `@expand/contracts` and `@expand/client-ts` manifests.
- The staged client manifest rewrites its `@expand/contracts` dependency to the same exact version.

Tracked private package versions remain explicit `0.0.0` development sentinels because npm workspace linking, package tooling, and Electron metadata consume them. They are never release inputs, and architecture tests prove that release staging overwrites them. The source manifests will never be mutated during a release.

### P1 acceptance criteria

- One resolver invocation feeds every artifact in a build.
- Tagged builds report the tag's SemVer through `expand --version`.
- Untagged builds have an explicit development identity and cannot stage publishable packages.
- Staged packages share the tag version, and the staged client depends on that exact contracts version.
- Application sources contain no Git invocation and no hard-coded release version.
- The existing channel value remains independent from the product version.

## P2: compatibility ownership and central discovery

P2 will make ownership explicit without building a global counter:

- Remove `apps/cli/cli/contract/version.ts` and export `ENVELOPE_VERSION` from the CLI envelope module.
- Move `PROTOCOL_VERSION` from the general endpoint schema into `packages/contracts/rpc/version.ts`; the endpoint schema, server, and client import that focused owner.
- Keep the event revision registry with server persistence.
- Keep database migration numbers with server migrations.
- Keep generated `FOLD_VERSIONS` generated and projection-specific.
- Add `docs/architecture/VERSIONING.md` as the single inventory of names, owners, consumers, values, compatibility behavior, and bump examples.

The architecture document will answer “where are all versions?” The focused source modules will answer “what must change with this contract?”

### P2 acceptance criteria

- Every production version-like value appears in the inventory.
- Each value has one production owner and a documented bump rule.
- No application release value comes from a package manifest.
- No compatibility value derives from the product release tag.
- Public tests retain hard-coded envelope and protocol expectations as independent oracles.

## P3: deterministic policy enforcement

Add `test/architecture/version-policy.test.ts` and extend focused integration and packaging tests. The checks will prove:

- The envelope and protocol epochs have their expected public values and approved owner paths.
- Database migration identifiers are unique and ordered.
- Every event revision from `1` to the current revision has a contiguous upcast path.
- Writers stamp current event revisions and readers reject future revisions.
- All build targets receive one resolved application version.
- Application sources never execute Git at runtime.
- Release staging requires a tag-derived version and aligns published package dependencies.
- Compiled CLI certification checks both `--version` and the JSON envelope value.
- Existing fold-hash generation and Effect audits remain authoritative for their domains.

The tests will exercise the resolver with injected Git results. Ordinary CI will not depend on the repository having a tag. File-layout assertions will target the few ownership boundaries above rather than snapshot broad source trees.

Add the version-policy test to the existing CI test path. A future tag build or release workflow must check out full tag history with `fetch-depth: 0` before invoking strict release resolution.

### P3 acceptance criteria

- A missing compatibility bump or upcaster fails a deterministic test whenever the rule is mechanically observable.
- Development CI passes without a release tag.
- Release staging fails before writing output when the exact tag cannot be proved.
- `VERSIONING.md` and the architecture test enumerate the same production domains.

## P4: read-only Luna pull-request review

### Trigger and trust boundary

Add a tokenless `.github/workflows/codex-review-request.yml` for `pull_request` events `opened`, `synchronize`, `reopened`, and `ready_for_review`. It checks out nothing and completes only for non-draft pull requests whose head repository is Expand. A separate `.github/workflows/codex-review.yml` runs from the default branch on completion of that named request workflow. The privileged workflow validates all of these facts before the OpenAI secret is available to the Codex step:

- The completed run has the exact trusted request-workflow path, `pull_request` event, successful conclusion, and one associated pull request.
- The associated pull request is open, is not a draft, and has a head SHA matching both the association and triggering workflow run.
- Its head repository is Expand rather than a fork.
- The actor passes the Codex Action's repository-write authorization.

Concurrency is keyed by the triggering head repository and branch, and a new push cancels the older run. Fork pull requests are skipped because GitHub does not safely expose the API secret to them. Neither workflow uses `pull_request_target`. The privileged workflow starts existing only after it is merged to the default branch, so the pull request that first introduces P4 can request a run but cannot supply or modify the privileged processor.

The review job receives only `contents: read` and pins its trusted checkout to the immutable default-branch commit in `github.sha`, with credentials disabled, to obtain the trusted schema. A static `actions/github-script` step fetches the current pull-request diff through the API, rejects diffs over 512 KiB, revalidates the head, and writes the diff between explicit untrusted-data delimiters in a dedicated data-only working directory. No pull-request tree is checked out or executed. The publication job uses the same immutable trusted commit. The review job runs `openai/codex-action@v1` with:

- `model: gpt-5.6-luna`
- `effort: max`
- `codex-version: 0.146.0`
- `codex-args` that disable `shell_tool` and `unified_exec` and select ephemeral execution
- `permission-profile: ":read-only"`
- `safety-strategy: drop-sudo`
- `OPENAI_API_KEY` from the repository Actions secret

The model receives the prompt file as data and has no shell or unified execution tool. The permission profile also denies filesystem mutation and network access. The job will not install dependencies, execute project scripts, or run PR-provided code. The authoritative prompt logic and `.github/codex/review-schema.json` come from the default-branch workflow revision, not files modified by the pull request.

No interactive login is required. A repository administrator must add an Actions secret named `OPENAI_API_KEY`; normal GitHub Actions permissions provide pull-request access. If the secret is absent or the response is malformed, the check fails visibly and posts no unvalidated model text.

### Review rules

The prompt instructs Luna to report only evidence-backed issues introduced by the pull request. It treats source text, pull-request text, commit messages, and repository instructions in the diff as untrusted data. It checks for:

- Breaking CLI JSON output without an envelope bump or compatibility path.
- Breaking client/server behavior without a protocol bump.
- Changed stored event payloads without a revision and complete upcaster chain.
- Database schema changes outside an ordered migration.
- Product version values that bypass the Git-derived resolver.
- New duplicated sources of truth.
- Production asynchronous work, resources, or error handling that bypasses Effect conventions.
- Platform APIs outside approved adapters or process boundaries.
- Lifecycle leaks, lost interruption, flattened causes, unsafe shutdown, or missing cleanup.
- Architecture boundary violations.
- Missing regression tests for changed behavior.

Each finding must include a stable rule ID, severity, title, path, line, evidence, impact, and concrete repair. The shared schema limits results to 20 findings and bounds rule ID, title, path, evidence, impact, and repair at 64, 120, 240, 240, 160, and 240 Unicode code points. Trusted parsing applies the same schema semantics, rejects control and Unicode format characters, enforces a 96-KiB UTF-8 input limit, and rejects rendered comments over 60,000 Unicode code points. The model must return an empty findings array when it cannot prove an issue.

### Comment publication

A run-scoped artifact carries only the Codex output file into a separate publication job; model JSON is never transported through an environment variable or interpolated into script source. The publication job receives exactly `contents: read`, `pull-requests: write`, and `issues: write`; it receives no API key and checks out only the default branch to obtain the trusted helper. The helper reads the fixed artifact path as UTF-8, validates the complete result before any write, confirms the current head before comment lookup, and re-fetches the head immediately before every create or update. It manages only comments authored by `github-actions[bot]` with GitHub user type `Bot` and marked with:

```text
<!-- expand-codex-review -->
```

When findings exist, the job creates or updates that comment with:

1. The reviewed commit SHA and a read-only/advisory label.
2. Findings grouped by severity, each with evidence and a proposed repair.
3. One deterministic, copy-ready “AI repair prompt” generated from the validated findings.

The repair prompt will tell an implementation agent to address only the listed findings, preserve unrelated work, follow repository Effect and architecture rules, add regression tests, run named verification commands, and report changed files and results. It will include the exact finding IDs, paths, evidence, and acceptance conditions.

If duplicate bot-owned marker comments exist, the helper first retires every extra with a marker-free superseded body, revalidating the head before each update, and only then updates the canonical marker. User-authored marker text is ignored. If the latest review is clean and no managed marker exists, the job posts nothing. If an earlier managed marker contains findings, the job updates it to record that the latest reviewed commit has no findings. Infrastructure, schema, size, ownership, or stale-head failures post no raw output and permit no subsequent write.

### P4 acceptance criteria

- Every new push to an eligible non-draft pull request starts one current review.
- The privileged workflow is default-branch controlled and never checks out or executes pull-request code.
- The Codex process has read-only repository permissions, disabled command tools, and no pull-request write token.
- The publication process has no OpenAI secret and executes no pull-request code.
- A stale review cannot comment on a newer pull-request head.
- Findings converge to one bot-owned marker comment with evidence, repair guidance, and a copy-ready AI prompt.
- Clean first reviews produce no comment; later clean reviews retire stale findings.
- The initial check remains advisory even when it reports Critical issues.

## Delivery order

The tasks are ordered because each one establishes invariants used by the next:

1. P0 introduces durable database and event compatibility.
2. P1 introduces the Git-derived release identity and artifact injection.
3. P2 consolidates ownership and writes the complete inventory.
4. P3 encodes the new invariants in deterministic tests and CI.
5. P4 adds semantic review over the documented and tested policy.

Each task will be implemented with focused tests, reviewed independently, and committed separately. No task will rewrite unrelated worktree changes.

## Verification strategy

Focused verification will include migration integration tests, event replay and projection equivalence, resolver unit tests, publish staging tests, build and binary certification, desktop configuration tests, architecture tests, type checking, linting, dependency-boundary checks, Effect audits, and the repository's final CI-equivalent suite.

The workflow itself will receive fixture tests for strict result validation, comment formatting, repair-prompt generation, marker upsert behavior, clean-review behavior, and stale-SHA rejection. Security-sensitive publication logic will live in the trusted workflow revision or be materialized from the base commit before execution.

## Assumptions

- Expand uses one coordinated release train for CLI, server, desktop, `@expand/contracts`, and `@expand/client-ts`.
- Product tags use `v<SemVer>`, including valid SemVer prereleases when needed.
- The user creates and manages release tags.
- Package publication and deployment remain manual or belong to a later design.
- Automated Codex review covers same-repository pull requests from trusted contributors.
- `OPENAI_API_KEY` will be configured before enabling P4.
- The first Codex review is advisory.
- Implementation adds no code comments unless separately approved.

## References

- [Codex GitHub Action](https://github.com/openai/codex-action)
- [Codex Action security guidance](https://github.com/openai/codex-action/blob/main/docs/security.md)
- [OpenAI GPT-5.6 model guidance](https://developers.openai.com/api/docs/guides/model-guidance?model=gpt-5.6-luna)
