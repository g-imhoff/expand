# App responsibility folder convention

## Goal

Organize every application under `apps/` by responsibility so a file's directory communicates why it exists. Remove underscore-prefixed helper filenames, eliminate vague source folders such as `lib`, and keep each executable or process entrypoint easy to find.

The convention applies to the CLI, server, TUI, and Electron desktop application. It standardizes folder meanings without forcing unrelated applications into identical directory trees.

## Principles

Each application uses only the responsibility folders it actually needs. No empty placeholder folders are added for symmetry.

Process boundaries come before responsibility folders. Electron therefore retains `main`, `preload`, `renderer`, and `shared` as its first-level source boundaries. Responsibilities are organized independently inside those boundaries.

Executable entrypoints may remain directly at an application or process root:

- CLI and server: `main.ts`
- TUI and renderer: `main.tsx`
- Electron main and preload: their configured `index.ts` entrypoints

All other source files belong to a named responsibility, except the CLI's focused `output.ts` module, which remains at the CLI root by explicit project choice. Folder names are lowercase nouns. Source filenames are descriptive kebab-case, while existing local React component case conventions remain unchanged. Leading underscores do not signal internal modules and will not be used.

This is an organizational refactor only. Exported symbols, RPC contracts, CLI output, runtime behavior, error semantics, and process boundaries remain unchanged.

## Alternatives considered

An identical application skeleton was rejected because it would introduce empty or misleading directories in applications that do not have those responsibilities.

A minimal rename-only pass was rejected because it would remove `_command.ts` and `_resolve.ts` without addressing the unclear root-level organization that motivated the change.

The selected design uses a shared responsibility vocabulary with an app-specific subset.

## CLI layout

`apps/cli/cli/main.ts` remains the composition root. The remaining root modules move as follows:

```text
apps/cli/cli/
├── main.ts
├── output.ts
├── commands/
│   ├── define-command.ts
│   ├── global-flags.ts
│   ├── health.ts
│   └── project/
│       ├── index.ts
│       ├── resolve-project-target.ts
│       ├── archive.ts
│       ├── change-directory.ts
│       ├── create.ts
│       ├── delete.ts
│       ├── list.ts
│       ├── rename.ts
│       ├── restore.ts
│       └── set-metadata.ts
├── runtime/
│   ├── app-context-layer.ts
│   └── node-app-context.ts
├── errors/
│   ├── index.ts
│   ├── render-errors.ts
│   ├── envelope.ts
│   ├── error-code.ts
│   ├── parser-errors.ts
│   ├── project-errors.ts
│   └── server-errors.ts
└── contract/
    ├── version.ts
    ├── project/
    └── server/
```

The concrete moves are:

- `_command.ts` to `commands/define-command.ts`
- `global-flags.ts` to `commands/global-flags.ts`
- `commands/project.ts` to `commands/project/index.ts`
- `commands/project/_resolve.ts` to `commands/project/resolve-project-target.ts`
- `app-context-layer.ts` to `runtime/app-context-layer.ts`
- `node-app-context.ts` to `runtime/node-app-context.ts`
- `run.ts` to `errors/render-errors.ts`

The focused `output.ts` module remains at the CLI root. The existing `contract` and `errors` trees remain otherwise intact because they already express clear responsibilities.

## Server layout

`apps/server/main.ts` remains the backend entrypoint. Existing clear responsibility folders remain: `application`, `composition`, `db`, and `rpc`.

```text
apps/server/
├── main.ts
├── application/
├── composition/
├── db/
├── rpc/
│   └── handlers.ts
├── runtime/
│   ├── connection-tracker.ts
│   ├── endpoint-file.ts
│   ├── node-app-context.ts
│   ├── node-process-control.ts
│   ├── server-config.ts
│   └── state-root-lock.ts
└── transport/
    └── http-server.ts
```

The concrete moves are:

- `rpc-handlers.ts` to `rpc/handlers.ts`
- `connection-tracker.ts`, `endpoint-file.ts`, `node-app-context.ts`, `node-process-control.ts`, `server-config.ts`, and `state-root-lock.ts` to `runtime/`
- `http.ts` to `transport/http-server.ts`
- `lib/ids.ts` to `application/ids.ts`

The vague `lib` folder is removed. ID generation belongs to application orchestration because it supplies identifiers to use cases and server composition.

## TUI layout

`apps/tui/main.tsx` remains the executable entrypoint. Existing `components` and `input` folders remain.

```text
apps/tui/
├── main.tsx
├── components/
├── input/
├── runtime/
│   ├── tui-runtime.ts
│   ├── effect-runner.ts
│   └── node-app-context.ts
└── features/
    └── projects/
        └── use-projects.ts
```

The concrete moves are:

- `runtime.ts` to `runtime/tui-runtime.ts`
- `effect-runner.ts` and `node-app-context.ts` to `runtime/`
- `use-projects.ts` to `features/projects/use-projects.ts`

The project hook is feature-specific state and behavior, while the Effect runner and host-derived application context belong to runtime ownership.

## Desktop layout

Electron's security boundaries remain unchanged:

```text
apps/desktop/src/
├── main/
├── preload/
├── renderer/
└── shared/
```

The main process keeps `index.ts` as its configured entrypoint. Its root support files move into responsibility folders:

```text
main/
├── index.ts
├── application/
│   └── main-program.ts
├── runtime/
│   ├── client-runtime.ts
│   ├── node-app-context.ts
│   └── supervised.ts
├── ipc/
├── rpc/
└── security/
```

The concrete moves are:

- `program.ts` to `application/main-program.ts`
- `runtime.ts` to `runtime/client-runtime.ts`
- `node-app-context.ts` to `runtime/node-app-context.ts`
- `lib/supervised.ts` to `runtime/supervised.ts`

The renderer retains its existing `app`, `components`, `features`, and `rpc` responsibilities. Its vague `lib` folder is removed:

- `renderer/lib/supervised.ts` moves to `renderer/app/supervised.ts`
- `renderer/lib/utils.ts` moves to `renderer/components/ui/class-names.ts`

The preload boundary contains only its entrypoint and ambient API declaration, so no additional nesting is introduced. The existing `shared/ipc` folder remains the pure cross-process registry boundary.

## Test layout

Tests remain organized by test responsibility:

- `unit`: one isolated unit or small collaboration
- `integration`: multiple real modules or process seams
- `ui`: rendered interaction behavior
- `contract`: stable public formats and compatibility
- `fixtures`: support programs and data used by tests

Test support files use descriptive names rather than leading underscores:

- `apps/tui/test/ui/_runtime-harness.ts` becomes `runtime-harness.ts`
- `apps/desktop/test/ui/_harness.tsx` becomes `ui-harness.tsx`

Tests are not mirrored mechanically beside every source folder. Their existing behavioral grouping remains useful and consistent.

## Folder vocabulary

The folders present after this refactor mean:

- `application`: use cases and application-level orchestration independent of host startup.
- `app`: frontend bootstrapping, routing, root ownership, and application shell concerns.
- `commands`: CLI command definitions, argument configuration, and command execution helpers.
- `components`: reusable visual or terminal UI building blocks.
- `composition`: assembly of layers and services into a runnable application.
- `contract`: stable CLI-owned external formats. Shared cross-application contracts remain in `packages/contracts`.
- `data`: feature-owned data access, stores, and query integration.
- `db`: database-backed stores, replay readers, and persistence-specific implementations.
- `errors`: application-specific error mapping, serialization, and terminal error rendering.
- `features`: user-facing functionality grouped by domain capability.
- `input`: keyboard bindings, input state, routing, and reducers.
- `ipc`: Electron inter-process channels and lifecycle coordination.
- `model`: feature-owned state, reducers, and view models.
- `pages`: route-level or screen-level compositions owned by a feature.
- `rpc`: RPC handlers, protocol adapters, and RPC transport-facing services.
- `runtime`: host integration, process lifecycle, platform services, connection runtimes, and resource supervision.
- `security`: Electron navigation, origin, content-security, and window hardening policy.
- `shared`: pure definitions shared across process boundaries within one application.
- `shell`: frontend application-shell composition owned beneath `app`.
- `transport`: network listeners and transport-server construction.

## Optional future folders

Future applications may add the following only when the responsibility exists:

- `adapters`: concrete implementations of application-owned ports for external systems.
- `assets`: static images, fonts, and other packaged resources.
- `config`: configuration schemas and resolution once configuration becomes large enough to stand apart from runtime setup.
- `domain`: app-owned pure business rules and entities that do not belong in shared contracts.
- `hooks`: reusable cross-feature UI hooks; feature-owned hooks remain within their feature.
- `jobs`: scheduled or long-running background jobs.
- `migrations`: application-owned state or database migrations.
- `observability`: logging, tracing, metrics, and diagnostic integration.
- `output`: terminal output modules if the current focused `output.ts` grows into multiple files.
- `styles`: shared styles and design tokens when they outgrow entrypoint-level styles.
- `workers`: worker-thread, subprocess, or web-worker entrypoints and protocols.

Names such as `common`, `helpers`, `misc`, `lib`, and `utils` are not responsibility names and should not be introduced as catch-all folders. A narrowly named utility file may live with the responsibility it serves.

## Import and reference migration

All absolute aliases, relative imports, test mocks, architecture assertions, build references, Effect audit inventories, and current documentation that name moved files will be updated in the same change.

Executable entrypoint paths remain stable, so package scripts and production build entrypoints do not change. References to backend internal modules change only by path; the frontend/backend dependency boundary remains unchanged.

Existing staged and unstaged user changes are preserved. Moves carry the current working-tree contents rather than restoring files from `HEAD`.

## Verification

The refactor is complete when:

1. no tracked first-party TypeScript or TSX source file under `apps/` has a leading underscore;
2. no tracked first-party production source folder named `lib` remains under `apps/`;
3. every non-entrypoint root source module covered by this design is in its designated responsibility folder;
4. repository searches find no imports or current documentation pointing at the removed paths;
5. CLI, server, TUI, desktop, and root TypeScript checks pass;
6. architecture and dependency-cruiser checks pass;
7. focused CLI, server, TUI, and desktop tests affected by the path moves pass;
8. the complete test suite passes.

## Non-goals

- changing runtime behavior, retry policy, error mapping, RPC behavior, or CLI output;
- changing package public entrypoints under `packages/`;
- forcing every app to contain every responsibility folder;
- moving test suites merely to mirror source paths;
- introducing barrel files except where an existing module naturally becomes a folder entrypoint;
- renaming React components solely to enforce a different filename case convention;
- refactoring module contents beyond changes required to preserve imports after moves.
