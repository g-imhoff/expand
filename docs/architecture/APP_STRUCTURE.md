# Application folder responsibilities

Applications use a shared folder vocabulary, but each app creates only the folders it needs. Electron process boundaries (`main`, `preload`, `renderer`, and `shared`) take precedence; responsibility folders live inside those boundaries.

Executable entrypoints remain at their app or process root. Other source files belong to a responsibility folder, except the CLI's focused `output.ts` module, which remains at the CLI root by explicit project choice. Folder names are lowercase nouns, filenames are descriptive, and leading underscores are not used to imply privacy.

## Current folders

- `app`: frontend bootstrapping, routing, root ownership, and application shell concerns.
- `application`: use cases and application-level orchestration independent of host startup.
- `commands`: CLI command definitions, argument configuration, and command execution helpers.
- `components`: reusable visual or terminal UI building blocks.
- `composition`: assembly of layers and services into a runnable application.
- `contract`: stable CLI-owned external formats; shared cross-app contracts belong in `packages/contracts`.
- `data`: feature-owned data access, stores, and query integration.
- `db`: database-backed stores, replay readers, and persistence-specific implementations.
- `errors`: app-specific error mapping, serialization, and terminal error rendering.
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

Domain or capability subfolders use their actual business name, such as `project`, `projects`, or `server`.

## Optional future folders

Create these only when the responsibility exists:

- `adapters`: concrete implementations of application-owned ports for external systems.
- `assets`: static images, fonts, and packaged resources.
- `config`: configuration schemas and resolution once configuration is large enough to stand apart from runtime setup.
- `domain`: app-owned pure business rules and entities that do not belong in shared contracts.
- `hooks`: reusable cross-feature UI hooks; feature-owned hooks stay inside their feature.
- `jobs`: scheduled or long-running background jobs.
- `migrations`: application-owned state or database migrations.
- `observability`: logging, tracing, metrics, and diagnostic integration.
- `output`: terminal output modules if the current focused `output.ts` grows into multiple files.
- `styles`: shared styles and design tokens once they outgrow entrypoint-level styles.
- `workers`: worker-thread, subprocess, or web-worker entrypoints and protocols.

Do not introduce `common`, `helpers`, `misc`, `lib`, or `utils` as catch-all folders. Put a narrowly named utility with the responsibility it serves.

## Tests

Tests remain grouped by behavior:

- `e2e`: packaged or browser-driven end-to-end behavior.
- `unit`: one isolated unit or small collaboration.
- `integration`: multiple real modules or process seams.
- `ui`: rendered interaction behavior.
- `contract`: stable public formats and compatibility.
- `fixtures`: support programs and data used by tests.

Test helpers use descriptive names such as `runtime-harness.ts` or `ui-harness.tsx`.
