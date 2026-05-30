import { defineConfig } from "electron-vite"
import react from "@vitejs/plugin-react"
import { resolve } from "node:path"

const repo = resolve(__dirname, "../..")
const alias = {
  "@yodea/contracts": resolve(repo, "packages/contracts"),
  "@yodea/client-core": resolve(repo, "packages/client-core"),
  "@yodea/desktop": resolve(__dirname, "src")
}

export default defineConfig({
  main: { resolve: { alias }, build: { rollupOptions: { input: resolve(__dirname, "src/main/index.ts") } } },
  preload: { resolve: { alias }, build: { rollupOptions: { input: resolve(__dirname, "src/preload/index.ts") } } },
  renderer: {
    plugins: [react()],
    resolve: { alias },
    build: { rollupOptions: { input: resolve(__dirname, "src/renderer/index.html") } }
  }
})
