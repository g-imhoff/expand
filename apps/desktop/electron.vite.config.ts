import { defineConfig } from "electron-vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { builtinModules } from "node:module"
import { resolve } from "node:path"

export const makeElectronConfig = (
  appVersion: string,
  selectedChannel: "dev" | "release"
) => {
  const here = import.meta.dirname
  const alias = {
    "@expand/desktop": resolve(here, "src")
  }

  const nodeBuiltins = [...builtinModules]
  const external = ["electron", "ws", ...nodeBuiltins]
  const quotedChannel = `"${selectedChannel}"`
  const quotedVersion = `"${appVersion}"`

  return defineConfig({
    main: {
      define: { __EXPAND_CHANNEL__: quotedChannel, __EXPAND_VERSION__: quotedVersion },
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
      define: { __EXPAND_CHANNEL__: quotedChannel, __EXPAND_VERSION__: quotedVersion },
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
      define: { __EXPAND_CHANNEL__: quotedChannel, __EXPAND_VERSION__: quotedVersion },
      plugins: [react(), tailwindcss()],
      resolve: { alias },
      build: { rollupOptions: { input: resolve(here, "src/renderer/index.html") } }
    }
  })
}

export default defineConfig(({ command }) =>
  makeElectronConfig(
    process.env.EXPAND_APP_VERSION ?? "0.0.0-dev",
    command === "build" ? "release" : "dev"
  )
)
