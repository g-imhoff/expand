# Node and npm Only Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every first-party Bun runtime, package-manager, build, test, SDK, CI, and documentation dependency so Node.js and npm are the repository's only supported JavaScript platform.

**Architecture:** Keep the existing backend ownership and RPC architecture while replacing its platform edge with Effect's Node services, Node HTTP server, Node SQLite driver, and the existing Node client adapter. Use `tsx` for TypeScript source execution, npm workspaces and lockfiles for installation, and esbuild to produce executable Node ESM artifacts for the CLI and server.

**Tech Stack:** Node.js 24 LTS, npm 11, TypeScript 6, Effect 4 beta, `@effect/platform-node`, `@effect/sql-sqlite-node`, `better-sqlite3`, `tsx`, esbuild, Vitest, Electron, Playwright.

## Global Constraints

- Node.js 24 LTS is the development and CI baseline; declare `node >=24` and `npm >=11`.
- npm is the only package manager; root and `docs/architecture` each have an authoritative `package-lock.json`.
- Delete the Bun adapter and its public export without a compatibility shim.
- Preserve backend ownership, endpoint authentication, RPC contracts, CLI behavior, state paths, and shutdown semantics.
- Built `dist/expand` and `dist/expand-server` are executable Node ESM programs and require Node at runtime.
- Keep `better-sqlite3` external to the esbuild bundles.
- Do not upgrade Effect or unrelated dependencies.
- Do not add code comments. Existing comments that describe Bun must be removed or rewritten as current Node documentation.
- Preserve the user's unstaged changes in `REVIEW.md`, `packages/client-ts/discovery.ts`, `packages/client-ts/rpc-client.ts`, and `packages/client-ts/spawn.ts`.
- Each implementation task is committed by a fresh project `tdd-implementer`, then gated by a fresh project `task-reviewer`; all Critical and Important findings go through one fresh fix wave and a repeated gate.

---

### Task 1: Establish the npm and Node Baseline

**Files:**
- Create: `.node-version`
- Create: `package-lock.json`
- Create: `docs/architecture/package-lock.json`
- Create: `test/architecture/node-package-manager.test.ts`
- Modify: `package.json`
- Modify: `packages/client-ts/package.json`
- Modify: `docs/architecture/package.json`

**Interfaces:**
- Consumes: existing npm workspace package names `@expand/contracts` and `@expand/client-ts` at version `0.0.0`.
- Produces: Node 24/npm 11 metadata; npm-compatible workspace ranges; installed `tsx`, esbuild, Node SQLite, YAML, and TOML dependencies for later tasks.

- [ ] **Step 1: Write the failing package-manager baseline test**

```ts
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const root = join(import.meta.dirname, "..", "..")
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))

describe("Node and npm baseline", () => {
  it("pins Node 24 and npm 11", () => {
    expect(readFileSync(join(root, ".node-version"), "utf8").trim()).toMatch(/^24(?:\.|$)/)
    expect(pkg.engines).toEqual({ node: ">=24", npm: ">=11" })
    expect(pkg.packageManager).toMatch(/^npm@11\./)
  })

  it("uses npm-compatible workspace dependency ranges", () => {
    expect(pkg.dependencies["@expand/contracts"]).toBe("0.0.0")
    expect(pkg.dependencies["@expand/client-ts"]).toBe("0.0.0")
  })
})
```

- [ ] **Step 2: Run the test and verify the baseline is absent**

Run: `bun --bun vitest run test/architecture/node-package-manager.test.ts`

Expected: FAIL because `.node-version`, `engines`, and `packageManager` do not exist and workspace dependencies still use `workspace:*`.

- [ ] **Step 3: Add the transitional Node/npm manifest metadata**

Set `.node-version` to the installed Node 24 release. Add this root metadata and the dependencies needed by the remaining tasks while retaining the old Bun dependencies only until Task 5:

```json
{
  "packageManager": "npm@11.12.1",
  "engines": {
    "node": ">=24",
    "npm": ">=11"
  },
  "dependencies": {
    "@effect/sql-sqlite-node": "4.0.0-beta.74",
    "@expand/client-ts": "0.0.0",
    "@expand/contracts": "0.0.0",
    "better-sqlite3": "^12.9.0",
    "smol-toml": "^1.6.1",
    "yaml": "^2.9.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "esbuild": "^0.27.4",
    "tsx": "^4.20.6"
  }
}
```

Change internal workspace dependency ranges from `workspace:*` to `0.0.0`. Convert `docs/architecture/package.json` script chaining from `bun run <script>` to `npm run <script>`.

- [ ] **Step 4: Generate npm lockfiles from clean npm dependency trees**

Run:

```bash
rm -rf node_modules docs/architecture/node_modules
npm install --ignore-scripts
npm install --ignore-scripts --prefix docs/architecture
```

Expected: root `package-lock.json` links both workspaces, the architecture lockfile pins LikeC4, and neither install reports an unsupported workspace protocol.

- [ ] **Step 5: Run the baseline and existing static checks**

Run:

```bash
npm exec -- vitest run test/architecture/node-package-manager.test.ts
npm exec -- tsc --noEmit
npm exec -- tsc --noEmit -p apps/desktop/tsconfig.json
```

Expected: all commands PASS.

- [ ] **Step 6: Commit the npm foundation**

```bash
git add .node-version package.json package-lock.json packages/client-ts/package.json docs/architecture/package.json docs/architecture/package-lock.json test/architecture/node-package-manager.test.ts
git commit -m "build: establish node npm baseline"
```

---

### Task 2: Make the Node Client Adapter the Sole Platform Seam

**Files:**
- Delete: `packages/client-ts/adapters/bun.ts`
- Delete: `packages/client-ts/test/integration/bun-adapter-spawn.test.ts`
- Modify: `packages/client-ts/backend-command.ts`
- Modify: `packages/client-ts/adapters/node.ts`
- Modify: `packages/client-ts/adapter.ts`
- Modify: `packages/client-ts/index.ts`
- Modify: `packages/client-ts/package.json`
- Modify: `packages/client-ts/tsup.config.ts`
- Modify: `packages/client-ts/scripts/prepare-publish.mjs`
- Modify: `packages/client-ts/test/unit/resolve-backend-command.test.ts`
- Modify: `packages/client-ts/test/unit/adapter-spawn-errors.test.ts`
- Modify: `packages/client-ts/test/unit/entrypoints.test.ts`
- Modify: `packages/client-ts/test/fixtures/spawn-lock-contender.ts`
- Modify: `packages/client-ts/test/integration/acquire-client.test.ts`
- Modify: `packages/client-ts/test/integration/bootstrap-window.test.ts`
- Modify: `packages/client-ts/test/integration/cross-store-sync.test.ts`
- Modify: `packages/client-ts/test/integration/discovery.test.ts`
- Modify: `packages/client-ts/test/integration/find-or-spawn.test.ts`
- Modify: `packages/client-ts/test/integration/node-adapter.test.ts`
- Modify: `packages/client-ts/test/integration/project-store.test.ts`
- Modify: `packages/client-ts/test/integration/reconnect.test.ts`
- Modify: `packages/client-ts/test/integration/snapshot-consistency.test.ts`
- Modify: `packages/client-ts/test/integration/spawn-lock.test.ts`
- Modify: `apps/cli/cli/main.ts`
- Modify: `apps/tui/runtime.ts`
- Modify: `apps/desktop/src/main/runtime.ts`
- Modify: `apps/desktop/e2e/helpers.ts`
- Modify: `examples/client-ts/adapter.ts`
- Modify: `examples/client-ts/bootstrap-projects.ts`
- Modify: `examples/client-ts/archive-stale.ts`
- Modify: `examples/client-ts/audit-log.ts`

**Interfaces:**
- Consumes: `resolveBackendCommand` priority order and `RuntimeAdapter` contract.
- Produces: `ResolveBackendCommandOptions.runtimeArgs?: ReadonlyArray<string>` inserted before `sourceEntry`; `makeNodeAdapter` as the only adapter implementation; Node source command shape `node --import tsx <entry>`.

- [ ] **Step 1: Add failing command-resolution and public-entrypoint tests**

Add this source-runtime assertion to `resolve-backend-command.test.ts`:

```ts
it("places Node runtime arguments before the TypeScript source entry", () => {
  const cmd = resolveBackendCommand({
    env: {},
    execPath: "node",
    runtimeArgs: ["--import", "tsx"],
    sourceEntry: realSource,
    sourceArgs: ["server"]
  })
  expect(cmd).toEqual(["node", "--import", "tsx", realSource, "server"])
})
```

Change the entrypoint assertion so `@expand/client-ts/adapters/node` is the sole adapter export and `@expand/client-ts/adapters/bun` is absent.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `npm exec -- vitest run packages/client-ts/test/unit/resolve-backend-command.test.ts packages/client-ts/test/unit/entrypoints.test.ts`

Expected: FAIL because `runtimeArgs` is not accepted and the Bun adapter export still exists.

- [ ] **Step 3: Extend backend command resolution**

Add the option and insert it before the source entry:

```ts
readonly runtimeArgs?: ReadonlyArray<string>
```

```ts
const { sourceEntry, sourceArgs = [], runtimeArgs = [], binaryArgs, execPath = process.execPath } = opts
if (sourceEntry !== undefined && SOURCE_ENTRY_RE.test(sourceEntry) && existsSync(sourceEntry)) {
  return [execPath, ...runtimeArgs, sourceEntry, ...sourceArgs]
}
```

Update the existing TSDoc contracts so source mode is defined as `[execPath, ...runtimeArgs, sourceEntry, ...sourceArgs]`.

- [ ] **Step 4: Convert application and example client edges to Node**

Use `NodeRuntime`, `NodeServices`, and `makeNodeAdapter`. Source backend commands use:

```ts
resolveBackendCommand({
  execPath: process.execPath,
  runtimeArgs: ["--import", "tsx"],
  sourceEntry,
  binaryArgs: [process.execPath, join(dirname(fileURLToPath(import.meta.url)), "expand-server")]
})
```

Electron uses `execPath: "node"` because `process.execPath` is Electron. Update its E2E override to `JSON.stringify(["node", "--import", "tsx", serverEntry])`. Examples provide `NodeServices.layer` and construct the Node adapter with the same source command.

Convert every client integration test and fixture to `NodeServices`, `NodeHttpServer`, `makeNodeAdapter`, `node --import tsx`, and `node:timers/promises` as applicable. These files must typecheck in this task; their full runtime execution is gated after the backend migration in Task 3.

- [ ] **Step 5: Delete the Bun adapter surface and migrate its unit coverage**

Remove the source file, export map entry, tsup entry, publish-staging export, package dependency, and Bun-only integration test. Rewrite `adapter-spawn-errors.test.ts` around `makeNodeAdapter({ backendCommand: [missingExecutable] })` and retain the `BackendUnavailable` assertion.

- [ ] **Step 6: Run the client-edge checks**

Run:

```bash
npm exec -- vitest run packages/client-ts/test/unit apps/desktop/test/unit
npm exec -- tsc --noEmit
npm exec -- tsc --noEmit -p apps/desktop/tsconfig.json
npm run build --workspace @expand/client-ts
```

Expected: all commands PASS and `packages/client-ts/dist/adapters/node.js` exists while no Bun adapter artifact exists.

- [ ] **Step 7: Commit the sole Node adapter**

```bash
git add packages/client-ts apps/cli/cli/main.ts apps/tui/runtime.ts apps/desktop/src/main/runtime.ts apps/desktop/e2e/helpers.ts examples/client-ts
git commit -m "refactor: keep only node client adapter"
```

---

### Task 3: Move the Backend and Integration Harnesses to Node

**Files:**
- Modify: `apps/server/main.ts`
- Modify: `apps/server/http.ts`
- Modify: `apps/server/composition/app.ts`
- Modify: `apps/cli/test/harness.ts`
- Modify: `apps/server/test/application/create-project.test.ts`
- Modify: `apps/server/test/application/rename-project.test.ts`
- Modify: `apps/server/test/unit/access-log-redaction.test.ts`
- Modify: `apps/server/test/fixtures/state-root-lock-contender.ts`
- Modify: `apps/server/test/integration/change-directory-e2e.test.ts`
- Modify: `apps/server/test/integration/concurrency.test.ts`
- Modify: `apps/server/test/integration/connect-during-shutdown.test.ts`
- Modify: `apps/server/test/integration/delete-e2e.test.ts`
- Modify: `apps/server/test/integration/durability-restart.test.ts`
- Modify: `apps/server/test/integration/e2e-lifecycle.test.ts`
- Modify: `apps/server/test/integration/endpoint-file.test.ts`
- Modify: `apps/server/test/integration/event-store.test.ts`
- Modify: `apps/server/test/integration/events-handler.test.ts`
- Modify: `apps/server/test/integration/events-replay.test.ts`
- Modify: `apps/server/test/integration/ops-lifecycle.test.ts`
- Modify: `apps/server/test/integration/project-event-store.test.ts`
- Modify: `apps/server/test/integration/projection-state-store.test.ts`
- Modify: `apps/server/test/integration/projection.test.ts`
- Modify: `apps/server/test/integration/replay-feed.test.ts`
- Modify: `apps/server/test/integration/set-metadata.test.ts`
- Modify: `apps/server/test/integration/snapshot-equivalence.test.ts`
- Modify: `apps/server/test/integration/sqlite-config.test.ts`
- Modify: `apps/server/test/integration/state-root-lock.test.ts`
- Modify: `apps/server/test/integration/trust-boundary.test.ts`
- Modify: `apps/server/test/integration/use-cases.test.ts`

**Interfaces:**
- Consumes: the Task 2 Node adapter and `runtimeArgs` backend command API.
- Produces: Node-backed server composition using `NodeRuntime`, `NodeServices`, `NodeFileSystem`, `NodeHttpServer`, and `@effect/sql-sqlite-node`; Node-backed integration fixtures.

- [ ] **Step 1: Add a failing Node HTTP-layer assertion**

In `apps/server/test/unit/access-log-redaction.test.ts`, import the Node platform and provide `NodeServices.layer`. Add an assertion that the server address is loopback and a token-bearing request still logs only the path.

```ts
expect(logOutput).not.toContain(token)
expect(logOutput).toContain("/rpc")
```

- [ ] **Step 2: Run the server unit test and verify the Node layer is missing**

Run: `npm exec -- vitest run apps/server/test/unit/access-log-redaction.test.ts`

Expected: FAIL while `apps/server/http.ts` still imports `BunHttpServer`.

- [ ] **Step 3: Replace the server platform layers**

Construct the HTTP layer with Node's server factory:

```ts
import { NodeHttpServer } from "@effect/platform-node"
import { createServer } from "node:http"

const node = NodeHttpServer.layer(createServer, {
  port,
  host: "127.0.0.1"
})
```

Replace server filesystem/runtime services with `NodeFileSystem`, `NodeRuntime`, and `NodeServices`. Replace every SQLite import with:

```ts
import { SqliteClient } from "@effect/sql-sqlite-node"
```

Keep the existing database layer construction, file permissions, HTTP shutdown scope, and Effect teardown mapping unchanged.

- [ ] **Step 4: Convert integration clients and fixtures**

Replace `BunServices.layer` with `NodeServices.layer`, `BunFileSystem.layer` with `NodeFileSystem.layer`, and `bunAdapter` with:

```ts
makeNodeAdapter({
  backendCommand: [process.execPath, "--import", "tsx", join(process.cwd(), "apps/server/main.ts")]
})
```

Use `setTimeout` from `node:timers/promises` in both lock-contender fixtures and timing-sensitive tests. Replace the two ad hoc Bun HTTP test servers with `NodeHttpServer.layer(createServer, { port: 0, gracefulShutdownTimeout: "500 millis" })`.

- [ ] **Step 5: Run all backend and client integration tests**

Run:

```bash
npm exec -- vitest run apps/server/test packages/client-ts/test/integration apps/cli/test
npm exec -- tsc --noEmit
```

Expected: all tests PASS under Node, including process-heavy state-root and spawn-lock projects.

- [ ] **Step 6: Commit the Node backend**

```bash
git add apps/server apps/cli/test packages/client-ts/test
git commit -m "refactor: run backend on node"
```

---

### Task 4: Replace Bun Utility APIs in Scripts, Benchmarks, and Architecture Checks

**Files:**
- Modify: `scripts/sync-agents.ts`
- Modify: `scripts/sync-agents.test.ts`
- Modify: `scripts/binary-smoke.test.ts`
- Modify: `scripts/binary-smoke.sh`
- Modify: `scripts/fold-version.ts`
- Modify: `bench/main.ts`
- Modify: `bench/rss.ts`
- Modify: `bench/report.ts`
- Modify: `bench/seed.ts`
- Modify: `bench/selfcheck.ts`
- Modify: `bench/scenarios/cold-boot.ts`
- Modify: `bench/scenarios/scan-drain.ts`
- Modify: `bench/scenarios/server-e2e.ts`
- Modify: `examples/client-ts/test/helpers.ts`
- Modify: `examples/client-ts/test/archive-stale.smoke.test.ts`
- Modify: `test/architecture/client-ts-barrel.test.ts`
- Modify: `test/architecture/effect-version-lockstep.test.ts`
- Modify: `test/architecture/fold-version-lockstep.test.ts`
- Modify: `test/architecture/i1-cli-isolation.test.ts`
- Modify: `test/architecture/ipc-boundary.test.ts`
- Modify: `test/architecture/no-dead-code.test.ts`
- Modify: `test/architecture/server-app-split.test.ts`

**Interfaces:**
- Consumes: direct `yaml`, `smol-toml`, `better-sqlite3`, Node Effect/SQLite services, and the sole Node adapter.
- Produces: Node-native filesystem, process, parser, timing, benchmark, and architecture-test behavior with no Bun globals or executables.

- [ ] **Step 1: Rewrite parser expectations to use direct Node packages**

In `scripts/sync-agents.test.ts`, import `parse as parseToml` from `smol-toml` and change every `Bun.TOML.parse` call to `parseToml`. Change the hook and CI assertions to `npm run agents:check`.

- [ ] **Step 2: Run the synchronizer tests and verify they fail**

Run: `npm exec -- vitest run scripts/sync-agents.test.ts`

Expected: FAIL because the implementation still calls `Bun.YAML.parse`, `Bun.argv`, and `import.meta.dir`.

- [ ] **Step 3: Convert the synchronizer implementation**

Use:

```ts
import { parse as parseYaml } from "yaml"
import { fileURLToPath } from "node:url"

const parsed = parseYaml(frontmatterSource)
const args = process.argv.slice(2)
const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)))
```

The usage error becomes `usage: npm run agents:sync -- [--check]`. Preserve roster validation and byte-for-byte output.

- [ ] **Step 4: Convert test and example subprocess helpers**

Use `readFile` from `node:fs/promises`, `spawn` from `node:child_process`, and Promise wrappers around `exit`, `error`, stdout, and stderr events. Example commands use `[process.execPath, "--import", "tsx", entry, ...args]`. Sleeps use `setTimeout` from `node:timers/promises`.

- [ ] **Step 5: Convert architecture command runners**

Replace `bunx <tool>` with npm's local binary runner:

```ts
execFileSync("npm", ["exec", "--", "depcruise", "apps", "packages", "--config", ".dependency-cruiser.cjs"], options)
```

Run Knip as `npm exec -- knip --no-progress`. Update command assertions and fold-version remediation text to `npm run`.

- [ ] **Step 6: Convert the benchmark harness**

Use the default `Database` export from `better-sqlite3`, Node SQLite Effect layers, Node services, and the Node adapter. Replace `Bun.gc(true)` with `globalThis.gc?.()`. Rename report schema field `bunVersion` to `nodeVersion` and source it from `process.version`. Benchmark scripts later run Node with `--expose-gc --import tsx`.

- [ ] **Step 7: Run utility, architecture, example, and benchmark checks**

Run:

```bash
npm exec -- vitest run scripts test/architecture examples/client-ts/test
npm exec -- vitest run test/architecture/fold-version-lockstep.test.ts
node --expose-gc --import tsx bench/selfcheck.ts
node --expose-gc --import tsx bench/main.ts --smoke
```

Expected: all commands PASS and no executed code requires a Bun global.

- [ ] **Step 8: Commit Node utility APIs**

```bash
git add scripts bench examples/client-ts/test test/architecture
git commit -m "refactor: replace bun utility APIs"
```

---

### Task 5: Finalize Node Builds, npm Workflows, Policy, and Documentation

**Files:**
- Create: `scripts/build.mjs`
- Create: `test/architecture/node-only.test.ts`
- Delete: `.bun-version`
- Delete: `bun.lock`
- Delete: `docs/architecture/bun.lock`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `packages/client-ts/package.json`
- Modify: `packages/contracts/package.json`
- Modify: `packages/client-ts/tsconfig.build.json`
- Modify: `packages/contracts/tsconfig.build.json`
- Modify: `packages/contracts/globals.d.ts`
- Modify: `packages/contracts/fold-version.generated.ts`
- Modify: `packages/client-ts/scripts/prepare-publish.mjs`
- Modify: `packages/contracts/scripts/prepare-publish.mjs`
- Modify: `tsconfig.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `.githooks/pre-commit`
- Modify: `.gitignore`
- Modify: `doctor.config.json`
- Modify: `.claude/agents/desktop-tester.md`
- Modify: `.claude/agents/manual-tester.md`
- Regenerate: `.codex/agents/desktop-tester.toml`
- Regenerate: `.codex/agents/manual-tester.toml`
- Modify: `REVIEW.md`
- Modify: `bench/README.md`
- Modify: `examples/client-ts/README.md`
- Modify: `examples/client-ts/ERGONOMICS.md`
- Modify: `packages/client-ts/README.md`
- Modify: `packages/client-ts/ARCHITECTURE.md`
- Modify: `docs/architecture/package.json`
- Modify: `docs/architecture/package-lock.json`

**Interfaces:**
- Consumes: the Node-only runtime and utility code from Tasks 2–4.
- Produces: executable `dist/expand` and `dist/expand-server`; npm-only scripts, hooks, CI, package publishing, documentation, and regression enforcement.

- [ ] **Step 1: Write the failing Node-only policy test**

```ts
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const root = join(import.meta.dirname, "..", "..")
const exempt = new Set([
  "package-lock.json",
  "docs/architecture/package-lock.json",
  "test/architecture/node-only.test.ts"
])

describe("Node-only repository policy", () => {
  it("has no Bun version, lock, or adapter files", () => {
    for (const path of [".bun-version", "bun.lock", "docs/architecture/bun.lock", "packages/client-ts/adapters/bun.ts"]) {
      expect(existsSync(join(root, path)), path).toBe(false)
    }
  })

  it("contains no tracked first-party Bun runtime or command references", () => {
    const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean)
    const offenders = files
      .filter((path) => !path.startsWith("docs/superpowers/") && !exempt.has(path))
      .filter((path) => /\b(?:bun|bunx)\b|@effect\/(?:platform-bun|sql-sqlite-bun)|bun:sqlite|oven-sh\/setup-bun/i.test(readFileSync(join(root, path), "utf8")))
    expect(offenders).toEqual([])
  })
})
```

- [ ] **Step 2: Run the policy test and capture the complete failure list**

Run: `npm exec -- vitest run test/architecture/node-only.test.ts`

Expected: FAIL with old lock/version files and current documentation, manifests, CI, hooks, package scripts, types, and agent definitions listed as offenders.

- [ ] **Step 3: Add the executable Node build script**

```js
import { chmod, mkdir, rm } from "node:fs/promises"
import { build } from "esbuild"

await rm("dist", { recursive: true, force: true })
await mkdir("dist", { recursive: true })

for (const [entry, outfile] of [
  ["apps/cli/cli/main.ts", "dist/expand"],
  ["apps/server/main.ts", "dist/expand-server"]
]) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    sourcemap: true,
    banner: { js: "#!/usr/bin/env node" },
    define: { __EXPAND_CHANNEL__: JSON.stringify("release") },
    external: ["better-sqlite3"]
  })
  await chmod(outfile, 0o755)
}
```

- [ ] **Step 4: Replace every root and workspace script with Node/npm execution**

The root script contract is:

```json
{
  "gen:fold-version": "tsx scripts/fold-version.ts",
  "agents:sync": "tsx scripts/sync-agents.ts",
  "agents:check": "tsx scripts/sync-agents.ts --check",
  "bench:events": "node --expose-gc --import tsx bench/main.ts",
  "bench:selfcheck": "node --expose-gc --import tsx bench/selfcheck.ts",
  "typecheck:all": "npm run typecheck && npm run typecheck:desktop",
  "test": "vitest run",
  "test:coverage": "vitest run --coverage",
  "test:watch": "vitest",
  "knip": "knip",
  "build": "node scripts/build.mjs",
  "cert:cli:build": "npm run build && bash scripts/binary-smoke.sh",
  "dev:cli": "tsx apps/cli/cli/main.ts",
  "dev:server": "tsx apps/server/main.ts",
  "dev:tui": "tsx apps/tui/main.tsx",
  "e2e:desktop": "npm run build:desktop && playwright test -c apps/desktop/e2e/playwright.config.ts"
}
```

Workspace package orchestration uses `npm run build`, `npm run stage:publish`, and `npm pack`. Remove `@effect/platform-bun`, `@effect/sql-sqlite-bun`, and `@types/bun`; use only Node types in every tsconfig.

- [ ] **Step 5: Convert hooks, CI, agent definitions, and architecture tooling**

CI checks out the repository, uses `actions/setup-node` with `.node-version` and npm caching, runs `npm ci`, then invokes npm scripts. The desktop job installs Playwright dependencies through `npm exec -- playwright install-deps chromium`. Hooks invoke `npm run agents:check`, `npm run lint`, and `npm run typecheck:all`.

Rewrite the two canonical Claude tester definitions to require Node/npm, use the built artifacts, use Node's WebSocket client or `ws` for the wrong-token probe, and use `node --import tsx` with `NodeServices` and `makeNodeAdapter` for the standing client. Run `npm run agents:sync` to regenerate their Codex mirrors.

- [ ] **Step 6: Rewrite all current-state documentation**

Replace setup, architecture, adapter, example, benchmark, generated-file remediation, publishing, and certification instructions with their Node/npm forms. Remove dual-runtime tables and describe only `@expand/client-ts/adapters/node`. Preserve the user's existing unstaged `REVIEW.md` status edits while rewriting its Bun-specific architecture and command references.

- [ ] **Step 7: Delete old package-manager artifacts and regenerate clean locks**

Run:

```bash
rm -f .bun-version bun.lock docs/architecture/bun.lock
rm -rf node_modules docs/architecture/node_modules
npm install
npm install --prefix docs/architecture
npm ci
```

Expected: npm installs `better-sqlite3`, links both workspaces, runs the npm-based prepare hook, and reproduces the dependency tree from `package-lock.json`.

- [ ] **Step 8: Run the complete local verification matrix**

Run:

```bash
npm run agents:check
npm run lint
npm run typecheck:all
npm run arch
npm run knip
npm run test
npm run build
npm run cert:cli:build
npm run build:desktop
npm run e2e:desktop
npm run build --workspace @expand/contracts
npm run pack:tgz --workspace @expand/contracts
npm run build --workspace @expand/client-ts
npm run pack:tgz --workspace @expand/client-ts
npm run bench:selfcheck
npm run bench:events -- --smoke
npm exec -- vitest run test/architecture/node-only.test.ts
```

Expected: every command PASS; both executable artifacts pass lifecycle smoke certification; desktop E2E passes; package tarballs are produced; policy test reports no offenders.

- [ ] **Step 9: Commit the completed migration**

```bash
git add -A
git commit -m "build: remove bun and standardize on node"
```

---

## Controller Completion Gates

After Task 5 and its task-review loop:

1. Dispatch the project `manual-tester` against the compiled Node CLI/backend lifecycle.
2. Dispatch the project `desktop-tester` against the built Electron application and cross-check its backend command.
3. Dispatch the project `code-reviewer` once across the complete branch.
4. Send every Critical and Important code-review finding through one fresh `tdd-implementer` fix wave, then re-run a fresh `task-reviewer` gate.
5. Invoke `superpowers:verification-before-completion` and independently rerun the authoritative clean-install, static, test, build, certification, packaging, desktop, benchmark-smoke, and tracked-file policy commands.
6. Invoke `superpowers:finishing-a-development-branch` only after all required evidence is green.
