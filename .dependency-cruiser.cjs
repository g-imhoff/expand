// Architectural fitness config — enforces BOUNDARIES.md I-1.
// Two rules together encode: backend/cli/** may import ONLY shared/, lib/, npm;
// the SOLE exception is backend/cli/commands/server.ts importing backend/composition/**.
module.exports = {
  forbidden: [
    {
      name: "cli-client-must-not-import-server",
      severity: "error",
      comment:
        "BOUNDARIES.md I-1: backend/cli/** must never import server-only modules. " +
        "The CLI is a thin RPC client; it may import only backend/shared, backend/lib, or npm.",
      from: { path: "^backend/cli/" },
      to: {
        path:
          "^backend/(server|application|domain|features|infrastructure|db|services)(/|$)"
      }
    },
    {
      name: "cli-composition-only-from-server-subcommand",
      severity: "error",
      comment:
        "BOUNDARIES.md I-1: only backend/cli/commands/server.ts may import backend/composition/**, " +
        "and only to boot the backend.",
      from: {
        path: "^backend/cli/",
        pathNot: "^backend/cli/commands/server\\.ts$"
      },
      to: { path: "^backend/composition(/|$)" }
    }
  ],
  options: {
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(node_modules|test)" }
  }
}
