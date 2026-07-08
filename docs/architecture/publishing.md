# Publishing `@expand/contracts` and `@expand/client-ts`

Status: **not yet published** (both at `0.0.0`, `private`). This documents how the two
publishable workspace packages are built and the policy for versioning them, so a real
publish is a checklist rather than a rediscovery.

## Why it's structured the way it is

The monorepo is an **npm workspace** (`"workspaces": ["packages/contracts", "packages/client-ts"]`).
The two packages resolve **two different ways on purpose**:

- **In-repo (dev/test/build):** each package's `package.json` `exports` point at **source `.ts`**.
  Every tool — `tsc`, `vitest` (with `test.server.deps.inline: [/@expand\//]`), `eslint`,
  dependency-cruiser, `knip`, and the production bundlers (`bun build --compile`,
  electron-vite) — resolves source directly. No build step is needed for development.
- **On publish:** a staging script rewrites `exports` to the built `dist/` and packs *that*,
  so the tracked `package.json` is **never mutated** and in-repo resolution can't break.

`@expand/contracts` uses a **wildcard** `exports` (`"./*": "./*.ts"`) — it's the shared
vocabulary, consumed by many subpaths. `@expand/client-ts` uses a **barrel-only** `exports`
(`.`, `./adapters/bun`, `./adapters/node`) so the `exports` map itself enforces the public
surface at the resolver level (internals throw `ERR_PACKAGE_PATH_NOT_EXPORTED`), alongside the
`client-ts-barrel-only` dependency-cruiser rule.

## Build recipe (per package)

- **`@expand/contracts`** — plain `tsc -p tsconfig.build.json` (it has only self-referential
  subpath imports, which Node resolves through the package's own `exports`, so no bundler is
  needed) → `dist/*.js` + `dist/*.d.ts`.
- **`@expand/client-ts`** — `tsup` (esbuild) for the `.js` (it has ~73 extensionless relative
  imports that must be rewritten for Node ESM; esbuild inlines each entry's internals into a
  single bundle) + `tsc -p tsconfig.build.json` with **`stripInternal: true`** for the `.d.ts`
  (drops every `/** @internal */` member from the published typings). Deps
  (`effect`, `@effect/platform-bun`, `ws`, `@expand/contracts`) are external, not bundled.

Both use a dependency-free **staging** script (`scripts/prepare-publish.mjs`): it writes a
publish-only `package.json` into git-ignored `dist-publish/` with `exports` repointed to
`./dist/*`, `private: false`, `files: ["dist"]`, and — for `client-ts` — the
`@expand/contracts` dependency **rewritten from `workspace:*` to a real version** (npm can't
install the `workspace:` protocol). `bun run pack:tgz` runs build → stage → `npm pack`.

`dist/` and `dist-publish/` are git-ignored — build output is never committed.

## Versioning ↔ wire-protocol policy

- The backend/clients negotiate over `PROTOCOL_VERSION` (currently **2**, in
  `packages/contracts/endpoint.ts`). Clients reject an endpoint whose `protocolVersion`
  differs.
- **Rule:** a change to `PROTOCOL_VERSION` is a **breaking** change to both packages — bump the
  **major** (once ≥ 1.0) or the pre-1.0 minor. A published `@expand/client-ts` documents which
  `PROTOCOL_VERSION`(s) it speaks; a client and backend from different protocol versions must
  not be mixed.
- **Effect-beta constraint:** both packages ride `effect@4.0.0-beta` **unstable** subpaths
  (`effect/unstable/rpc`, `effect/unstable/socket`). Beta APIs break between releases, so **no
  stable semver promise is possible** until Effect 4 ships. Publish only as `0.x` / explicit
  pre-1.0, declare `effect` with an honest beta range (peer or pinned), and state that the SDK
  tracks Effect beta.

## Go-to-publish checklist

1. Effect 4 is stable (or you accept a pre-1.0 beta-tracking release).
2. Set real `version`s (respecting the protocol-version rule) and `private: false`.
3. `bun run --filter '@expand/*' build` and `pack:tgz`; validate each tarball: `exports`→`dist`,
   no raw `.ts`, `@internal` absent from `client-ts` typings, `@expand/contracts` dep is a real
   version (no `workspace:`), and an ESM smoke import resolves. (These are already validated in
   the current staging scripts.)
4. Publish `@expand/contracts` first, then `@expand/client-ts` (its dep).

## Deferred (tracked)

- **api-extractor API report** for `@expand/client-ts`: not wired — `@microsoft/api-extractor`
  7.58.x bundles TS 5.9 and the repo is on TS 6.0, which throws an internal analyzer defect.
  `stripInternal` already produces the trimmed public typings; re-attempt the api-extractor
  *report* (public-surface change tracking) when it ships a TS 6.x-compatible engine.
- **`supervised`** (a generic fiber-death logger) is `@internal` in `client-ts` and duplicated
  as two private copies in `apps/desktop`. Candidate to relocate to a shared `@expand/effect-utils`
  workspace package to dedupe — deferred as low-value churn.
