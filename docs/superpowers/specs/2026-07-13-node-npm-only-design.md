# Node and npm Only Migration

## Goal

Remove Bun as a runtime, package manager, build tool, test assumption, public SDK option, and documented workflow. Node.js and npm become the only supported JavaScript runtime and package manager for the repository.

The finished repository must install from npm lockfiles, execute every first-party workflow through Node.js, expose only the Node client adapter, and contain no first-party command or runtime path that requires Bun.

## Scope

The migration covers:

- root and nested package-manager metadata and lockfiles;
- application runtimes for the server, CLI, TUI, and Electron main process;
- Effect platform, HTTP, filesystem, runtime, and SQLite layers;
- the public `@expand/client-ts` adapter surface;
- development, generation, benchmark, build, packaging, test, lint, and architecture scripts;
- subprocess and filesystem helpers used by tests and examples;
- Git hooks and GitHub Actions;
- architecture, SDK, example, review, and agent documentation;
- compiled-artifact, CLI lifecycle, and desktop end-to-end certification.

Historical design specs may describe the migration. Third-party metadata inside npm lockfiles may contain incidental Bun-named fields supplied by dependencies. Neither counts as supported Bun usage.

## Runtime Baseline

Node.js 24 LTS is the development and CI baseline. The root manifest declares the Node engine and the npm package-manager version, and `.node-version` selects the Node 24 line. `.bun-version` and every `bun.lock` file are deleted.

The root npm workspace owns `packages/contracts` and `packages/client-ts`. Internal workspace dependency ranges use npm-compatible version ranges rather than the `workspace:` protocol. The root `package-lock.json` is authoritative for the application and library workspaces. `docs/architecture` remains an independent package and receives its own `package-lock.json` because it is installed and operated separately.

CI uses `actions/setup-node`, npm caching, `npm ci`, and `npm run`. Local hooks and documentation use the same commands.

## Application Runtime Architecture

The application retains its existing process architecture: one backend owns a selected state root, and the CLI, TUI, desktop app, and SDK clients discover or spawn that backend through `@expand/client-ts`.

The platform implementation changes as follows:

- `NodeRuntime` replaces `BunRuntime` at executable entrypoints.
- `NodeServices` and Node filesystem services replace Bun service layers.
- `NodeHttpServer` replaces the Bun HTTP server while preserving the loopback-only WebSocket RPC endpoint and shutdown behavior.
- `@effect/sql-sqlite-node` replaces `@effect/sql-sqlite-bun`. Its `better-sqlite3` dependency remains an installed native dependency and is not embedded into a standalone executable.
- the existing Node socket and subprocess adapter becomes the only client runtime adapter.

`packages/client-ts/adapters/bun.ts`, its export, dependencies, tests, and documentation are deleted. `@expand/client-ts/adapters/node` remains explicit so consumers still select and provide the platform layer deliberately. This is an intentional public API break; no compatibility shim remains.

## Source Execution and Backend Spawning

First-party TypeScript source is executed through Node.js with `tsx`. npm scripts invoke `tsx` directly for development servers, CLIs, the TUI, generators, benchmarks, and maintenance utilities.

Backend command resolution must distinguish source and built modes:

1. `EXPAND_BACKEND_CMD`, when present, remains the highest-priority explicit override.
2. Source mode launches Node with the `tsx` import hook before the server TypeScript entrypoint.
3. Built mode launches Node with the sibling built server artifact.

The command resolver gains a representation for runtime arguments that occur before the source entrypoint. This avoids embedding a `tsx` binary path and allows the portable command shape `node --import tsx <entry>`.

Electron cannot use `process.execPath` for the backend because that path is the Electron executable. Its development command therefore selects `node` explicitly. Built CLI commands use `process.execPath`, which is the Node executable, and locate the server artifact relative to the CLI artifact rather than relative to the Node installation.

Spawn failures, malformed overrides, missing source/build commands, readiness deadlines, endpoint validation, state-root locking, and detached-process behavior retain their existing typed failure semantics.

## Build and Distribution

The project does not adopt Node single-executable applications. Reproducing Bun compilation through SEA would add experimental packaging machinery and native-addon extraction without serving the Node/npm-only goal.

Instead, a Node build script uses esbuild to bundle the CLI and server into executable ESM files at:

- `dist/expand`
- `dist/expand-server`

Both artifacts carry a Node shebang and executable mode. First-party workspace code and ordinary JavaScript dependencies may be bundled. `better-sqlite3` stays external so Node loads its installed native addon normally.

The CLI artifact spawns the sibling server artifact with the same Node executable. The existing binary smoke suite continues to certify ownership, durability, auto-spawn, process cleanup, and command behavior against these built artifacts. The artifacts require a compatible Node installation; they are executable Node programs, not runtime-free native binaries.

The library package builds and publish-staging flows remain ESM and declaration builds, but every orchestration command uses npm. Published `@expand/client-ts` metadata exposes only the root, project, server, Node adapter, and package metadata entrypoints.

## Tooling and Test Migration

Runtime-specific helper calls are replaced with focused Node APIs:

- `node:fs/promises` or `node:fs` for file reads;
- `node:child_process` for spawned commands;
- `node:timers/promises` or Effect timing for sleeps;
- `process.argv` for script arguments;
- direct `yaml` and `smol-toml` dependencies for agent-definition parsing.

Vitest runs directly under Node. Node Effect services and Node SQLite layers are used in unit and integration harnesses. HTTP integration fixtures use `NodeHttpServer`. Tests that existed only to certify the Bun adapter are deleted or rewritten to certify the sole Node adapter.

Knip runs through its standard Node entrypoint. Dependency-cruiser, ESLint, TypeScript, Playwright, React Doctor, architecture generators, and package staging run through npm or `npx` only where a deliberately unpinned one-shot tool is already intended.

## Regression Policy

An architecture test enforces the Node-only boundary. It verifies that:

- Bun version and lock files do not exist;
- first-party manifests declare no direct Bun packages;
- the Bun adapter subpath and source file do not exist;
- tracked first-party runtime, configuration, CI, hook, example, and documentation files contain no Bun commands, globals, runtime imports, or setup actions.

The policy test excludes itself, this historical migration spec, and npm lockfile fields that merely reproduce third-party package metadata.

## Documentation

Current-state documentation is rewritten around Node and the Node adapter. Command examples use `npm run`, `npm exec`, or direct built executable invocation as appropriate. Architecture descriptions name Node as the sole platform. Agent tester definitions use the same npm certification commands as human contributors and CI.

No current documentation presents Bun as supported, optional, or required.

## Verification

The migration is complete only when a clean npm installation and the entire Node workflow pass. Required evidence is:

1. root `npm ci` succeeds from `package-lock.json` after removing the prior Bun-installed `node_modules` tree;
2. the independent architecture package installs from its npm lockfile;
3. agent synchronization, lint, all TypeScript projects, architecture boundaries, Knip, and the complete Vitest suite pass through npm scripts;
4. CLI and server artifacts build and pass the compiled-artifact smoke suite;
5. Electron builds and its Playwright end-to-end suite passes;
6. library build and package-staging flows pass;
7. the Node-only architecture policy passes;
8. a final tracked-file search finds no unapproved Bun runtime, tooling, adapter, command, dependency, or current documentation reference.

The project-scoped manual tester certifies compiled CLI/backend lifecycle behavior, the desktop tester certifies the built Electron renderer and backend seam, a task reviewer gates each implementation wave, and a code reviewer inspects the complete branch before final controller verification.

## Non-Goals

- preserving the Bun adapter or a dual-runtime SDK;
- producing a runtime-free native executable;
- upgrading Effect or unrelated dependencies beyond changes required for the Node platform;
- redesigning state ownership, RPC contracts, application behavior, or user-facing commands;
- refactoring unrelated modules encountered during the migration.
