import { defineConfig, externalizeDepsPlugin } from "electron-vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { builtinModules } from "node:module"
import { resolve } from "node:path"

export const makeElectronConfig = (appVersion: string) => {
  const here = import.meta.dirname
  const repo = resolve(here, "../..")
  const alias = {
    "@expand/electron-ipc": resolve(repo, "packages/electron-ipc"),
    "@expand/desktop": resolve(here, "src")
  }

  const nodeBuiltins = [...builtinModules]
  const external: Array<string | RegExp> = [
    "electron",
    "effect",
    /^effect\//,
    /^@effect\//,
    "ws",
    ...nodeBuiltins
  ]
  const quotedVersion = `"${appVersion}"`

  return defineConfig({
    main: {
      define: { __EXPAND_VERSION__: quotedVersion },
      plugins: [externalizeDepsPlugin()],
      resolve: { alias },
      build: {
        rollupOptions: {
          input: resolve(here, "src/main/index.ts"),
          external,
          output: { format: "es", entryFileNames: "index.mjs" }
        }
      }
    },
    preload: {
      define: { __EXPAND_VERSION__: quotedVersion },
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
      define: { __EXPAND_VERSION__: quotedVersion },
      plugins: [react(), tailwindcss()],
      resolve: { alias },
      build: { rollupOptions: { input: resolve(here, "src/renderer/index.html") } }
    }
  })
}

export default makeElectronConfig(
  (Reflect.get(globalThis, "process") as NodeJS.Process).env.EXPAND_APP_VERSION ?? "0.0.0-dev"
)
