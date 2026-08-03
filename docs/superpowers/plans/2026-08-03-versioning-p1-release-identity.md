# P1 Git-Derived Release Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve one product version from the exact Git tag at build time and embed it in every shipped artifact and staged package.

**Architecture:** A pure resolver interprets injected Git observations; an Effect adapter performs Git probes only in build and release tooling. Build scripts resolve once and transport an inert string to esbuild, electron-vite, and package staging. Runtime modules read only the compiled global.

**Tech Stack:** TypeScript, Effect process services, esbuild, electron-vite, npm package staging, Vitest.

## Global Constraints

- Accept product tags matching `v<valid SemVer>` and strip only the leading `v`.
- Release mode fails for no exact release tag, more than one exact release tag, or malformed SemVer.
- Development mode returns `0.0.0-dev+<12-character-sha>` or `0.0.0-dev` without Git metadata.
- Environment variables may transport a value to electron-vite; they never originate a release identity.
- The CLI, server, desktop, contracts package, and client package receive the same resolved string.
- Tracked source manifests never supply the release version and are never mutated by staging.
- Public `stage:publish` and `pack:tgz` commands require release mode.
- Package certification may inject `0.0.0-cert.0` only through the exported staging function and must remove its stage directories.
- No runtime application module invokes Git.
- No code comments are added.

---

### Task 1: Build and stage one tag-derived product identity

**Files:**

- Create: `scripts/app-version.ts`
- Create: `scripts/app-version.test.ts`
- Create: `packages/contracts/build-info.ts`
- Modify: `packages/contracts/globals.d.ts`
- Modify: `scripts/build.ts`
- Modify: `scripts/build.test.ts`
- Modify: `scripts/desktop-command.ts`
- Modify: `scripts/desktop-command.test.ts`
- Modify: `apps/desktop/electron.vite.config.ts`
- Create: `apps/desktop/test/unit/build-version.test.ts`
- Modify: `apps/cli/cli/main.ts`
- Modify: `apps/server/main.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `packages/contracts/scripts/prepare-publish.ts`
- Modify: `packages/contracts/test/prepare-publish.test.ts`
- Modify: `packages/client-ts/scripts/prepare-publish.ts`
- Modify: `packages/client-ts/test/prepare-publish.test.ts`
- Modify: `scripts/package-certification.ts`
- Modify: `scripts/package-certification.test.ts`
- Modify: `scripts/binary-smoke.ts`
- Modify: `scripts/binary-smoke.test.ts`
- Modify: `effect-candidate-inventory.json` only if the Effect audit records the electron-vite environment read

**Interfaces:**

- Produces: `AppVersionMode = "development" | "release"`.
- Produces: `resolveAppVersionObservation(observation, mode): Effect.Effect<string, AppVersionError>`.
- Produces: `resolveAppVersion(root, mode): Effect.Effect<string, AppVersionError, ChildProcessSpawner>`.
- Produces: `appVersion: string` in `packages/contracts/build-info.ts`.
- Changes: `buildOptions(root, entry, outfile, appVersion)` and `buildBinaries(root, appVersion)` require one already resolved value.
- Changes: `runDesktopCommand(root, mode, appVersion)` transports one already resolved value.
- Changes: both package `stage(root, releaseVersion)` functions require an explicit resolved value.
- Produces: package certification reports include `version` and `dependencies`.

- [ ] **Step 1: Write failing resolver tests**

Create `scripts/app-version.test.ts` with table-driven cases for the pure resolver:

```ts
expect(yield* resolveAppVersionObservation({ exactTags: ["v1.2.3"], shortSha: "0123456789ab" }, "release")).toBe("1.2.3")
expect(yield* resolveAppVersionObservation({ exactTags: ["v1.2.3-rc.1"], shortSha: "0123456789ab" }, "release")).toBe("1.2.3-rc.1")
expect(yield* resolveAppVersionObservation({ exactTags: [], shortSha: "0123456789ab" }, "development")).toBe("0.0.0-dev+0123456789ab")
expect(yield* resolveAppVersionObservation({ exactTags: [], shortSha: undefined }, "development")).toBe("0.0.0-dev")
```

Assert tagged release failures for `v01.2.3`, `v1.2`, `release-1.2.3`, two matching tags, and no tag. Assert that unrelated non-release tags are excluded by the Git adapter. Use `processSpawnerFixture` to prove the adapter runs `git tag --points-at HEAD --list v*` and `git rev-parse --short=12 HEAD`, trims output, and maps nonzero Git exits to development fallback only in development mode.

- [ ] **Step 2: Run the resolver tests and confirm the red state**

```bash
npm exec -- vitest run scripts/app-version.test.ts
```

Expected: FAIL because the resolver does not exist.

- [ ] **Step 3: Implement the resolver and Git adapter**

Define:

```ts
export interface AppVersionObservation {
  readonly exactTags: ReadonlyArray<string>
  readonly shortSha: string | undefined
}

export class AppVersionError extends Data.TaggedError("AppVersionError")<{
  readonly reason: "git-probe" | "missing-release-tag" | "conflicting-release-tags" | "invalid-release-tag" | "invalid-sha"
  readonly detail: string
  readonly cause?: unknown
}> {}
```

Use a full SemVer regular expression that rejects leading zeroes and accepts valid prerelease and build identifiers. Keep observation resolution pure. Implement the Git adapter with `ChildProcessSpawner`, collect stdout and stderr through Effect streams, and never import a Node child-process API.

- [ ] **Step 4: Write failing build-metadata tests**

Extend `scripts/build.test.ts` to call `buildBinaries("/repo", "1.2.3")` and assert that both captured esbuild options contain:

```ts
define: {
  __EXPAND_CHANNEL__: '"release"',
  __EXPAND_VERSION__: '"1.2.3"'
}
```

Extend `desktop-command.test.ts` to call `runDesktopCommand("/repo", "build", "1.2.3")` and assert the spawned command receives `EXPAND_APP_VERSION=1.2.3` without changing the parent environment. Add `apps/desktop/test/unit/build-version.test.ts` to import a named `makeElectronConfig("1.2.3")` and assert `main.define`, `preload.define`, and `renderer.define` all define the same quoted value.

- [ ] **Step 5: Implement shared build info and artifact injection**

Add to `globals.d.ts`:

```ts
declare const __EXPAND_VERSION__: string
```

Create `build-info.ts`:

```ts
export const appVersion = typeof __EXPAND_VERSION__ === "undefined"
  ? "0.0.0-dev"
  : __EXPAND_VERSION__
```

Pass `appVersion` explicitly into `buildOptions` and `buildBinaries`. Resolve development mode once in `scripts/build.ts`'s executable program. Pass `appVersion` in the child environment from `runDesktopCommand`; resolve it once in the desktop command's executable path. Export `makeElectronConfig(appVersion)` and make the default export call it with `process.env.EXPAND_APP_VERSION ?? "0.0.0-dev"`.

Use `appVersion` in the CLI's `Command.run`. Prepend one `Effect.logInfo` carrying `appVersion` to the server and desktop main programs without changing `Endpoint` or any RPC schema. Keep the existing `NodeRuntime.runMain` ownership and teardown behavior.

Retain the tracked `0.0.0` values as explicit private-workspace sentinels because npm workspace linking, package tooling, and Electron metadata consume them. Add no synchronization from those fields to build output; staged manifests always overwrite them with the resolved argument.

- [ ] **Step 6: Run focused build and desktop tests**

```bash
npm exec -- vitest run scripts/app-version.test.ts scripts/build.test.ts scripts/desktop-command.test.ts apps/desktop/test/unit/build-version.test.ts
npm run typecheck:all
```

Expected: PASS.

- [ ] **Step 7: Write failing fixed-group package staging tests**

Change each prepare-publish fixture to call `stage(root, "4.5.6")`. Assert the staged manifest uses `4.5.6` even when the source manifest contains `0.0.0`. For the client, assert:

```ts
expect(published.dependencies["@expand/contracts"]).toBe("4.5.6")
```

Add strict command-path tests for a missing exact release tag. Extend package certification fixtures so the contracts and client reports both expose `version: "0.0.0-cert.0"`, and the client report exposes `dependencies["@expand/contracts"] === "0.0.0-cert.0"`.

- [ ] **Step 8: Implement explicit package version staging**

Change both stage functions to accept `releaseVersion: string`, assign it to the staged manifest, and stop reading `source.version` as an output value. The client stage rewrites only `@expand/contracts`; it preserves every external dependency range.

Make the executable `stage` and `pack` subcommands resolve `resolveAppVersion(repositoryRoot, "release")` before staging. Keep build-only subcommands tag-independent.

In `package-certification.ts`, export the existing `Workspace` type and introduce a `PackageStager` service with this shape:

```ts
export class PackageStager extends Context.Service<PackageStager, {
  readonly stage: (workspace: Workspace, root: string, version: string) => Effect.Effect<void, PackageCertificationError>
}>()("expand/PackageStager") {}
```

The live service calls the correct exported package stage function with `0.0.0-cert.0`; the unit-test layer supplies a no-op stager. Replace the spawned `stage:publish` command in certification with this service. Decode dependencies in `PublishedManifest`, return `version` and `dependencies` in `PackageCertificationReport`, and assert fixed-group alignment before installing tarballs.

- [ ] **Step 9: Certify compiled identity**

Extend the binary smoke program to run `./dist/expand --version`, require the untagged build result to match `0.0.0-dev` with optional build metadata, and retain the existing JSON envelope checks. Extend `binary-smoke.test.ts` with success and mismatch fixtures.

- [ ] **Step 10: Run focused release verification**

```bash
npm exec -- vitest run scripts/app-version.test.ts scripts/build.test.ts scripts/desktop-command.test.ts apps/desktop/test/unit/build-version.test.ts packages/contracts/test/prepare-publish.test.ts packages/client-ts/test/prepare-publish.test.ts scripts/package-certification.test.ts scripts/binary-smoke.test.ts
npm run cert:packages
npm run cert:cli:build
npm run typecheck:all
npm run effect:audit
```

Expected: all commands PASS. If the Effect audit reports the new electron-vite environment boundary, update its registered inventory through the repository's existing audit update path and rerun the audit.

- [ ] **Step 11: Commit P1**

```bash
git add scripts/app-version.ts scripts/app-version.test.ts packages/contracts/build-info.ts packages/contracts/globals.d.ts scripts/build.ts scripts/build.test.ts scripts/desktop-command.ts scripts/desktop-command.test.ts apps/desktop/electron.vite.config.ts apps/desktop/test/unit/build-version.test.ts apps/desktop/src/main/index.ts apps/cli/cli/main.ts apps/server/main.ts packages/contracts/scripts/prepare-publish.ts packages/contracts/test/prepare-publish.test.ts packages/client-ts/scripts/prepare-publish.ts packages/client-ts/test/prepare-publish.test.ts scripts/package-certification.ts scripts/package-certification.test.ts scripts/binary-smoke.ts scripts/binary-smoke.test.ts effect-candidate-inventory.json
git commit -m "feat(release): derive artifacts from Git tags"
```
