const nodeOsImport = "platform:import:" + ["node", "os"].join(":")
const processCwd = ["platform:process", "cwd"].join(".")

export const effectHostBoundaries = Object.freeze([
  Object.freeze({
    file: "apps/cli/cli/main.ts",
    declaration: "module:<module>",
    host: "Node application entrypoint",
    construct: "runner:NodeRuntime.runMain",
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/cli/cli/node-app-context.ts",
    declaration: "module:<module>",
    host: "Node AppContext host acquisition",
    construct: nodeOsImport,
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/cli/cli/node-app-context.ts",
    declaration: "member:cwd.try",
    host: "Node AppContext host acquisition",
    construct: processCwd,
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/desktop/src/main/node-app-context.ts",
    declaration: "module:<module>",
    host: "Node AppContext host acquisition",
    construct: nodeOsImport,
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/desktop/src/main/node-app-context.ts",
    declaration: "member:cwd.try",
    host: "Node AppContext host acquisition",
    construct: processCwd,
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/server/main.ts",
    declaration: "module:<module>",
    host: "Node application entrypoint",
    construct: "runner:NodeRuntime.runMain",
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/server/node-app-context.ts",
    declaration: "module:<module>",
    host: "Node AppContext host acquisition",
    construct: nodeOsImport,
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/server/node-app-context.ts",
    declaration: "member:cwd.try",
    host: "Node AppContext host acquisition",
    construct: processCwd,
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/tui/node-app-context.ts",
    declaration: "module:<module>",
    host: "Node AppContext host acquisition",
    construct: nodeOsImport,
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/tui/node-app-context.ts",
    declaration: "member:cwd.try",
    host: "Node AppContext host acquisition",
    construct: processCwd,
    occurrence: 0
  }),
  Object.freeze({
    file: "examples/client-ts/node-app-context.ts",
    declaration: "module:<module>",
    host: "Node AppContext host acquisition",
    construct: nodeOsImport,
    occurrence: 0
  }),
  Object.freeze({
    file: "examples/client-ts/node-app-context.ts",
    declaration: "member:cwd.try",
    host: "Node AppContext host acquisition",
    construct: processCwd,
    occurrence: 0
  }),
  Object.freeze({
    file: "scripts/effect-audit.ts",
    declaration: "module:<module>",
    host: "Node audit entrypoint",
    construct: "runner:NodeRuntime.runMain",
    occurrence: 0
  })
])
