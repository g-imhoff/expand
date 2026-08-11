# Versioning

Expand has separate product, compatibility, migration, cache, tooling, and dependency versions. Each domain belongs to the contract it governs. No global runtime counter coordinates them.

## Product release

- **Owner:** The exact `v<SemVer>` Git tag on the built commit is the release authority. `scripts/app-version.ts` resolves it at build time; `scripts/build.ts`, `scripts/desktop-command.ts`, and the package staging scripts pass the result into artifacts.
- **Consumers:** The CLI, server, desktop main/preload/renderer bundles, `@expand/contracts`, and `@expand/client-ts` use the same release version. The two packages form a fixed group, including the staged client dependency on contracts.
- **Current value or rule:** No release exists until a built commit has one exact valid tag. Untagged development builds use `0.0.0-dev+<12-hex-sha>`, or `0.0.0-dev` when Git metadata is unavailable. `packages/contracts/build-info.ts` exposes the injected value to application runtime code.
- **Compatibility:** A release tag identifies all shipped artifacts but does not alter any compatibility epoch. Release builds fail when the exact tag is missing, malformed, or ambiguous.
- **Examples:** Tagging a release commit `v1.4.0` creates a new product version and requires every artifact to report `1.4.0`. Rebuilding an untagged commit or changing a benchmark script requires no release bump.

## Tracked workspace manifests

- **Owner:** `package.json`, `apps/desktop/package.json`, `packages/contracts/package.json`, `packages/client-ts/package.json`, and `docs/architecture/package.json` own development metadata needed by their tools.
- **Consumers:** npm workspaces, Electron tooling, package build scripts, and the architecture documentation toolchain read these manifests.
- **Current value or rule:** Tracked private manifests and workspace dependency links use `0.0.0` sentinels where tooling requires a version. Package staging replaces sentinels only in copied publish manifests.
- **Compatibility:** A tracked manifest version is never a release source and never drives a compatibility decision.
- **Examples:** Staging `@expand/contracts` and `@expand/client-ts` for `v1.4.0` replaces both copied package versions and aligns the copied dependency. Adding a development script requires no manifest-version bump.

## CLI envelope

- **Owner:** `packages/contracts/cli/version.ts` defines `ENVELOPE_VERSION = "expand/v1"`; `packages/contracts/endpoint.ts` re-exports it for import compatibility.
- **Consumers:** Only CLI JSON envelope schemas, constructors, error rendering, and external CLI JSON consumers use this epoch.
- **Current value or rule:** The current CLI envelope epoch is `expand/v1`.
- **Compatibility:** Bump the epoch for a breaking CLI output-shape or interpretation change. Additive output that existing consumers can safely ignore stays in the current epoch.
- **Examples:** Renaming the top-level `kind` field requires `expand/v2`. Adding a new command whose results use the existing envelope shape requires no bump.

## Backend protocol

- **Owner:** `packages/contracts/rpc/version.ts` defines `PROTOCOL_VERSION = 2`; `packages/contracts/endpoint.ts` re-exports it for import compatibility.
- **Consumers:** `apps/server/composition/app.ts` advertises the value in endpoint files, and `packages/client-ts/discovery.ts` accepts only matching backends.
- **Current value or rule:** The bilateral backend protocol epoch is `2`.
- **Compatibility:** Bump it when an old client and a new server, or a new client and an old server, cannot communicate safely. The CLI envelope and product release do not affect it.
- **Examples:** Removing an RPC request field that existing clients send requires protocol `3`. Adding an optional response field that both sides tolerate requires no bump.

## SQLite schema

- **Owner:** `apps/server/migrations/sqlite.ts` owns `DATABASE_MIGRATIONS` and `CURRENT_DATABASE_MIGRATION`; Effect SQL owns the `effect_sql_migrations` ledger.
- **Consumers:** Server startup runs the ordered migrations before event and projection stores become available.
- **Current value or rule:** Migration `1_initial` is current. Add the next unique integer migration and advance `CURRENT_DATABASE_MIGRATION`; never edit a migration that may have run.
- **Compatibility:** Migrations upgrade older databases in order, preserve committed data, and fail startup on unsupported future migration records.
- **Examples:** Adding a persisted index requires an append-only `2_...` migration. Changing an in-memory query without changing stored schema requires no migration bump.

## Stored events

- **Owner:** `apps/server/migrations/events.ts` owns `EVENT_REVISIONS` and `EVENT_UPCASTERS` for persisted payloads.
- **Consumers:** `apps/server/db/event-store.ts` stamps new rows with the current per-tag revision and upcasts rows during replay.
- **Current value or rule:** `ProjectCreated` is revision `2`; `ProjectRenamed`, `ProjectDirectoryChanged`, `ProjectArchived`, `ProjectRestored`, `ProjectMetadataChanged`, `ProjectDeleted` are revision `1`.
- **Compatibility:** Bump only a changed event tag. Supply a contiguous upcaster for every revision through the new current shape. Unknown tags, missing upcasters, invalid revisions, and future revisions fail replay.
- **Examples:** Adding `directory` to stored `ProjectCreated` required revision `2` and the `1` to `2` upcaster. Changing how the UI labels `ProjectRenamed` requires no event-revision bump.

## Projection folds

- **Owner:** `scripts/fold-version.ts` hashes the registered fold source and generates `packages/contracts/fold-version.generated.ts`.
- **Consumers:** `apps/server/application/projections.ts` validates stored projection checkpoints; benchmark seeding stamps checkpoints with the same values.
- **Current value or rule:** Each projection value is `sha256:<digest>` over canonical registered fold nodes. Run `npm run gen:fold-version` after changing a fold; `test/architecture/fold-version-lockstep.test.ts` rejects stale output.
- **Compatibility:** A matching hash permits cache restoration. A mismatch discards the checkpoint and rebuilds the projection from stored events; it does not change event or RPC compatibility.
- **Examples:** Changing `Project` fold logic requires hash regeneration and causes old caches to rebuild. Changing a renderer component requires no fold-version change.

## Benchmark seed cache

- **Owner:** `bench/seed.ts` owns `GENERATOR_VERSION` and the deterministic seed-cache filename.
- **Consumers:** Benchmark seeding and the database cache under `bench/.cache/` use the generator epoch with scale and PRNG seed.
- **Current value or rule:** The generator epoch is `2`; cached files include `g2` in their names.
- **Compatibility:** Bump the generator epoch whenever generated bytes or their meaning change. The new filename invalidates old caches without affecting product, event, or projection versions.
- **Examples:** Changing event weights or serialized seed rows requires generator epoch `2`. Changing benchmark result formatting requires no generator bump.

## Internal Effect commands

- **Owner:** `scripts/desktop-command.ts` and each `packages/*/scripts/prepare-publish.ts` invocation owns its Effect CLI metadata.
- **Consumers:** Repository contributors see these values in development-only command help and version output.
- **Current value or rule:** These internal commands use the development sentinel `0.0.0`. The shipped CLI instead receives `appVersion` from `packages/contracts/build-info.ts`.
- **Compatibility:** Internal command metadata is independent from the product release. Give a command a supported product version only if it becomes a shipped product artifact.
- **Examples:** Shipping `desktop-command` as a supported user CLI would require replacing its private sentinel under that command's ownership. Cutting `v1.4.0` for existing artifacts requires no internal-command metadata bump.

## Runtime and dependency pins

- **Owner:** `.node-version` pins Node; `package.json` pins npm and root dependencies; `docs/architecture/package.json` pins the documentation toolchain; `package-lock.json` and `docs/architecture/package-lock.json` own resolved dependency graphs.
- **Consumers:** Local development, CI, application builds, tests, and architecture-document builds use these pins.
- **Current value or rule:** Node is `24.17.0`, npm is `11.12.1`, and runtime Effect packages stay in lockstep at `4.0.0-beta.74`. The documentation toolchain has its own pinned manifest and lockfile.
- **Compatibility:** Update each pin through its existing manifest, lockfile, lockstep, and architecture checks. Dependency pins neither derive from nor set the product release or compatibility epochs.
- **Examples:** Upgrading Effect requires updating its lockstep pins and lockfiles together. Releasing unchanged dependencies under a new product tag requires no dependency-pin bump.
