import { resolve } from "node:path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@expand/desktop": resolve(import.meta.dirname, "../../apps/desktop/src") }
  },
  server: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    fs: { allow: [resolve(import.meta.dirname, "../..")] }
  },
  build: {
    outDir: resolve(import.meta.dirname, "../../.tmp/design-preview"),
    emptyOutDir: true
  }
})
