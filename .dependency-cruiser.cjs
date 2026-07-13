module.exports = {
  forbidden: [
    {
      name: "frontends-must-not-import-backend",
      severity: "error",
      comment:
        "BOUNDARIES.md I-1: no frontend or packages/client-ts may import backend-only modules.",
      from: { path: "^(apps/cli/cli|apps/tui|apps/desktop/src|packages/client-ts)/" },
      to: { path: "^apps/server(/|$)" }
    },
    {
      name: "renderer-must-not-import-client-ts",
      severity: "error",
      comment:
        "BOUNDARIES.md I-1: renderer and preload reach backend only through the preload-brokered MessagePort.",
      from: { path: "^apps/desktop/src/(renderer|preload)/" },
      to: { path: "^(packages/client-ts|apps/desktop/src/main)(/|$)" }
    },
    {
      name: "client-ts-barrel-only",
      severity: "error",
      comment:
        "Scoped-entrypoints spec (2026-07-09): @expand/client-ts exposes only its " +
        "entrypoints — index.ts (connection core), project/index.ts, server/index.ts, " +
        "and adapters/* — external code must not deep-import its internals.",
      from: { pathNot: "^packages/client-ts/" },
      to: {
        path: "^packages/client-ts/",
        pathNot: "^packages/client-ts/(index\\.ts$|project/index\\.ts$|server/index\\.ts$|adapters/)"
      }
    },
    {
      name: "electron-ipc-package-isolated",
      severity: "error",
      comment:
        "BOUNDARIES.md I-1 (amended): the generic IPC framework imports no app code.",
      from: { path: "^packages/electron-ipc/" },
      to: { path: "^(apps|packages)/", pathNot: "^packages/electron-ipc/" }
    },
    {
      name: "shared-ipc-stays-pure",
      severity: "error",
      comment:
        "BOUNDARIES.md I-1 (amended): the IPC registry imports only the framework contract.",
      from: { path: "^apps/desktop/src/shared/ipc/" },
      to: { path: "^(apps|packages)/", pathNot: "^(packages/electron-ipc/contract|apps/desktop/src/shared/ipc)" }
    },
    {
      name: "preload-imports-allowlist",
      severity: "error",
      comment:
        "BOUNDARIES.md I-1 (amended): the preload may import only the IPC framework and the registry.",
      from: { path: "^apps/desktop/src/preload/" },
      to: { path: "^(apps|packages)/", pathNot: "^(packages/electron-ipc|apps/desktop/src/shared/ipc|apps/desktop/src/preload)/" }
    },
    {
      name: "ink-input-package-isolated",
      comment:
        "packages/ink-input is a generic leaf utility: it must not depend on apps or sibling packages (ADR: docs/superpowers/specs/2026-06-13-tui-input-architecture-design.md)",
      severity: "error",
      from: { path: "^packages/ink-input" },
      to: { path: "^(apps/|packages/(?!ink-input))" }
    },
    {
      name: "client-ts-no-circular",
      severity: "error",
      comment:
        "No import cycles inside the @expand/client-ts SDK (Phase B structural cleanup). " +
        "Scoped to packages/client-ts to catch SDK-internal cycles without asserting on " +
        "pre-existing cycles elsewhere in the repo.",
      from: { path: "^packages/client-ts/" },
      to: { path: "^packages/client-ts/", circular: true }
    },
    {
      name: "renderer-no-node-appcontext",
      severity: "error",
      comment: "The renderer and preload must not acquire or depend on application AppContext state.",
      from: { path: "^apps/desktop/src/(renderer|preload)/" },
      to: { path: "^packages/contracts/app-context(\\.ts)?$" }
    }
  ],
  options: {
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    doNotFollow: { path: "node_modules" },
    exclude: {
      path: [
        "(^|/)node_modules(/|$)",
        "(^|/)test(/|$)",
        "(^|/)out(/|$)",
        "(^|/)dist(/|$)",
        "(^|/)test-results(/|$)"
      ]
    }
  }
}
