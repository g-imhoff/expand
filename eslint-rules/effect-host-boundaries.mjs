const nodeCryptoImport = "platform:import:" + ["node", "crypto"].join(":")
const nodeHttpImport = "platform:import:" + ["node", "http"].join(":")
const nodeOsImport = "platform:import:" + ["node", "os"].join(":")
const processCwd = ["platform:process", "cwd"].join(".")
const processKill = ["platform:process", "kill"].join(".")
const processPid = ["platform:process", "pid"].join(".")
const processUmask = ["platform:process", "umask"].join(".")

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
    file: "apps/server/http.ts",
    declaration: "module:<module>",
    host: "Node HTTP adapter",
    construct: nodeCryptoImport,
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/server/http.ts",
    declaration: "module:<module>",
    host: "Node HTTP adapter",
    construct: nodeHttpImport,
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/server/main.ts",
    declaration: "module:<module>",
    host: "Node application entrypoint",
    construct: processUmask,
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
    file: "apps/server/node-process-control.ts",
    declaration: "member:nodeProcessControlLayer.currentPid",
    host: "Node ProcessControl host acquisition",
    construct: processPid,
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/server/node-process-control.ts",
    declaration: "member:probe.try",
    host: "Node ProcessControl host acquisition",
    construct: processKill,
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
    file: "packages/client-ts/adapters/node-process-control.ts",
    declaration: "member:nodeProcessControlLayer.currentPid",
    host: "Node ProcessControl host acquisition",
    construct: processPid,
    occurrence: 0
  }),
  Object.freeze({
    file: "packages/client-ts/adapters/node-process-control.ts",
    declaration: "member:probe.try",
    host: "Node ProcessControl host acquisition",
    construct: processKill,
    occurrence: 0
  }),
  Object.freeze({
    file: "packages/client-ts/adapters/node.ts",
    declaration: "module:<module>",
    host: "Node WebSocket adapter",
    construct: "platform:import:ws",
    occurrence: 0
  }),
  Object.freeze({
    file: "packages/client-ts/adapters/node.ts",
    declaration: "variable:wsConstructor",
    host: "Node WebSocket adapter",
    construct: "platform:ws.WebSocket",
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
