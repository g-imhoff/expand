// Architectural fitness config — enforces BOUNDARIES.md I-1.
// Two rules together encode: apps/cli/cli/** may import ONLY shared/, lib/, npm;
// the SOLE exception is apps/cli/cli/commands/server.ts importing apps/cli/composition/**.
module.exports = {
  forbidden: [
    {
      name: "frontends-must-not-import-backend",
      severity: "error",
      comment:
        "BOUNDARIES.md I-1: no frontend (apps/cli/cli, apps/tui, apps/desktop) and not " +
        "packages/client-core may import backend-only modules. Frontends share ONLY " +
        "packages/contracts + packages/client-core.",
      from: { path: "^(apps/cli/cli|apps/tui|apps/desktop/src|packages/client-core)/" },
      to: { path: "^apps/cli/(server|application|domain|features|infrastructure|db|services)(/|$)" }
    },
    {
      name: "composition-only-from-server-subcommand",
      severity: "error",
      comment:
        "BOUNDARIES.md I-1: only apps/cli/cli/commands/server.ts may import apps/cli/composition/**, " +
        "and only to boot the backend.",
      from: {
        path: "^(apps/cli/cli|apps/tui|apps/desktop/src|packages/client-core)/",
        pathNot: "^apps/cli/cli/commands/server\\.ts$"
      },
      to: { path: "^apps/cli/composition(/|$)" }
    },
    {
      name: "renderer-must-not-import-client-core",
      severity: "error",
      comment:
        "BOUNDARIES.md I-1: the Electron renderer AND preload are pure. They may import " +
        "ONLY packages/contracts + the typed effect/unstable/rpc contract client (+ npm " +
        "UI libs) and reach the backend solely via the preload-brokered MessagePort — " +
        "never client-core or the Electron main process.",
      from: { path: "^apps/desktop/src/(renderer|preload)/" },
      to: { path: "^(packages/client-core|apps/desktop/src/main)(/|$)" }
    }
  ],
  options: {
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(node_modules|test|(^|/)out/|(^|/)dist/)" }
  }
}
