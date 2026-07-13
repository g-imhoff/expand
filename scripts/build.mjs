import { chmod, mkdir, rm } from "node:fs/promises"
import { build } from "esbuild"

await rm("dist", { recursive: true, force: true })
await mkdir("dist", { recursive: true })

for (const [entry, outfile] of [
  ["apps/cli/cli/main.ts", "dist/expand"],
  ["apps/server/main.ts", "dist/expand-server"]
]) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    sourcemap: true,
    banner: {
      js: '#!/usr/bin/env node\nimport { createRequire as __expandCreateRequire } from "node:module"; const require = __expandCreateRequire(import.meta.url);'
    },
    define: { __EXPAND_CHANNEL__: JSON.stringify("release") },
    external: ["better-sqlite3"]
  })
  await chmod(outfile, 0o755)
}
