import { defineConfig, externalizeDepsPlugin } from "electron-vite"
import react from "@vitejs/plugin-react"
import { builtinModules } from "node:module"
import { resolve } from "node:path"

// Native ESM (type:module): use import.meta.dirname rather than CJS __dirname.
const here = import.meta.dirname
const repo = resolve(here, "../..")
const alias = {
  "@yodea/contracts": resolve(repo, "packages/contracts"),
  "@yodea/client-core": resolve(repo, "packages/client-core"),
  "@yodea/desktop": resolve(here, "src")
}

// npm deps that must NOT be bundled into the main/preload ESM output. Bundling
// them inlines CJS shims (e.g. electron's index.js calls path.join(__dirname,…),
// which throws in an ESM scope) and native loaders. These are resolved from
// node_modules by the Electron/Node runtime at launch instead.
//
// Workspace aliases (@yodea/contracts, @yodea/client-core, @yodea/desktop) are
// tsconfig/vite PATH ALIASES, not npm packages — there is nothing on disk to
// require() at runtime — so they are intentionally left OUT of this list and
// get inlined via resolve.alias above.
const nodeBuiltins = [
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`)
]
const external: Array<string | RegExp> = [
  "electron",
  "effect",
  /^effect\//,
  /^@effect\//,
  "ws",
  ...nodeBuiltins
]

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: { rollupOptions: { input: resolve(here, "src/main/index.ts"), external } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: { rollupOptions: { input: resolve(here, "src/preload/index.ts"), external } }
  },
  renderer: {
    plugins: [react()],
    resolve: { alias },
    build: { rollupOptions: { input: resolve(here, "src/renderer/index.html") } }
  }
})
