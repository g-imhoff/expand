import { defineConfig } from "tsup"

// Publishable ESM build for @expand/client-ts — JavaScript only.
//
// Why tsup (not plain tsc): the source uses ~73 extensionless relative imports
// (`./errors`, `../adapter`, …). tsc would emit those verbatim, producing ESM
// that Node cannot resolve. esbuild (via tsup) resolves them by inlining each
// entry's own local modules into a single bundle, leaving only the runtime deps
// as external `import`s — we ship references, not copies of effect/ws/contracts.
//
export default defineConfig({
  entry: {
    "index": "index.ts",
    "project/index": "project/index.ts",
    "server/index": "server/index.ts",
    "adapters/node": "adapters/node.ts"
  },
  format: ["esm"],
  outDir: "dist",
  target: "es2022",
  platform: "node",
  tsconfig: "tsconfig.build.json",
  dts: false,
  clean: true,
  // With multiple entries sharing internals (rpc-client.ts is reachable from
  // index, project, AND server), splitting emits shared chunks so each internal
  // module exists ONCE in dist — no duplicated module state across entrypoints.
  splitting: true,
  sourcemap: false,
  treeshake: false,
  // Do NOT bundle dependencies — ship references, resolved from the consumer's
  // node_modules. The tracked package.json declares each as a dependency.
  external: [
    "effect",
    /^effect\//,
    "ws",
    "@effect/platform-node",
    /^@effect\/platform-node\//,
    "@effect/platform-node-shared",
    /^@effect\/platform-node-shared\//,
    "@expand/contracts",
    /^@expand\/contracts\//
  ]
})
