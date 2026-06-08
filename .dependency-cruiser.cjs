module.exports = {
  forbidden: [
    {
      name: "frontends-must-not-import-backend",
      severity: "error",
      comment:
        "BOUNDARIES.md I-1: no frontend or packages/client-core may import backend-only modules.",
      from: { path: "^(apps/cli/cli|apps/tui|apps/desktop/src|packages/client-core)/" },
      to: { path: "^apps/server(/|$)" }
    },
    {
      name: "renderer-must-not-import-client-core",
      severity: "error",
      comment:
        "BOUNDARIES.md I-1: renderer and preload reach backend only through the preload-brokered MessagePort.",
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
