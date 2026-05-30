import { defineConfig } from "electron-vite"
import react from "@vitejs/plugin-react"
import { resolve } from "node:path"

// Native ESM (type:module): use import.meta.dirname rather than CJS __dirname.
const here = import.meta.dirname
const repo = resolve(here, "../..")
const alias = {
  "@yodea/contracts": resolve(repo, "packages/contracts"),
  "@yodea/client-core": resolve(repo, "packages/client-core"),
  "@yodea/desktop": resolve(here, "src")
}

export default defineConfig({
  main: { resolve: { alias }, build: { rollupOptions: { input: resolve(here, "src/main/index.ts") } } },
  preload: { resolve: { alias }, build: { rollupOptions: { input: resolve(here, "src/preload/index.ts") } } },
  renderer: {
    plugins: [react()],
    resolve: { alias },
    build: { rollupOptions: { input: resolve(here, "src/renderer/index.html") } }
  }
})
