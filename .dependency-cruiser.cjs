// Architectural fitness config — enforces BOUNDARIES.md I-1.
// Two rules together encode: apps/cli/cli/** may import ONLY shared/, lib/, npm;
// the SOLE exception is apps/cli/cli/commands/server.ts importing apps/cli/composition/**.
module.exports = {
  forbidden: [
    {
      name: "cli-client-must-not-import-server",
      severity: "error",
      comment:
        "BOUNDARIES.md I-1: apps/cli/cli/** must never import server-only modules. " +
        "The CLI is a thin RPC client; it may import only apps/cli/shared, apps/cli/lib, or npm.",
      from: { path: "^apps/cli/cli/" },
      to: {
        path:
          "^apps/cli/(server|application|domain|features|infrastructure|db|services)(/|$)"
      }
    },
    {
      name: "cli-composition-only-from-server-subcommand",
      severity: "error",
      comment:
        "BOUNDARIES.md I-1: only apps/cli/cli/commands/server.ts may import apps/cli/composition/**, " +
        "and only to boot the backend.",
      from: {
        path: "^apps/cli/cli/",
        pathNot: "^apps/cli/cli/commands/server\\.ts$"
      },
      to: { path: "^apps/cli/composition(/|$)" }
    }
  ],
  options: {
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(node_modules|test)" }
  }
}
