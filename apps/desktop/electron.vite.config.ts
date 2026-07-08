import { defineConfig, externalizeDepsPlugin } from "electron-vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { builtinModules } from "node:module"
import { resolve } from "node:path"

const here = import.meta.dirname
const repo = resolve(here, "../..")
const alias = {
  "@expand/contracts": resolve(repo, "packages/contracts"),
  "@expand/client-core": resolve(repo, "packages/client-core"),
  "@expand/electron-ipc": resolve(repo, "packages/electron-ipc"),
  "@expand/desktop": resolve(here, "src")
}

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
    resolve: { alias },
    build: {
      rollupOptions: {
        input: resolve(here, "src/preload/index.ts"),
        external: ["electron", ...nodeBuiltins],
        output: { format: "cjs", entryFileNames: "index.cjs" }
      }
    }
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    resolve: { alias },
    build: { rollupOptions: { input: resolve(here, "src/renderer/index.html") } }
  }
})
