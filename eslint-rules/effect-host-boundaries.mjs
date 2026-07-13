export const effectHostBoundaries = Object.freeze([
  Object.freeze({
    file: "apps/cli/cli/main.ts",
    declaration: "module:<module>",
    host: "Node application entrypoint",
    construct: "runner:NodeRuntime.runMain",
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/server/main.ts",
    declaration: "module:<module>",
    host: "Node application entrypoint",
    construct: "runner:NodeRuntime.runMain",
    occurrence: 0
  })
])
