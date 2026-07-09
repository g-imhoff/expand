// Produces a publish-ready staging directory (`dist-publish/`) whose package.json
// points `exports` at the built `dist/` (bundled ESM .js + per-file .d.ts) instead
// of the in-repo source `.ts`. The tracked package.json is NEVER mutated, so
// in-repo resolution (which relies on `exports` -> source `.ts`) keeps working.
//
// Two client-ts specifics beyond the contracts recipe:
//   1. Exports stay BARREL-ONLY — only ".", "./adapters/bun", "./adapters/node"
//      and "./package.json" are exposed; internal modules (rpc-client, spawn, …)
//      are unreachable. (They are also physically absent: tsup bundles each entry.)
//   2. The `@expand/contracts` dependency is rewritten from the in-repo
//      `workspace:*` protocol to the real version from packages/contracts, so the
//      published tarball is installable outside the workspace.
//
// Flow:  bun run build              -> tsup emits ./dist/*.js, tsc emits ./dist/*.d.ts
//        node scripts/prepare-publish.mjs -> writes ./dist-publish/{package.json, dist/**}
//        npm pack ./dist-publish    -> tarball whose package.json exports resolve dist/*.js
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..")
const distDir = join(pkgDir, "dist")
const stageDir = join(pkgDir, "dist-publish")

if (!existsSync(distDir)) {
  console.error("[prepare-publish] ./dist not found — run `bun run build` first.")
  process.exit(1)
}

const src = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"))

// Resolve the workspace `@expand/contracts` version to the real published version.
const contractsPkg = JSON.parse(readFileSync(join(pkgDir, "..", "contracts", "package.json"), "utf8"))
const dependencies = { ...src.dependencies }
if (typeof dependencies["@expand/contracts"] === "string" && dependencies["@expand/contracts"].startsWith("workspace:")) {
  dependencies["@expand/contracts"] = contractsPkg.version
}

// Publish-time package.json: source `exports` (-> ./*.ts) swapped for dist
// (-> ./dist/*), keeping the barrel-only surface.
const publishPkg = {
  name: src.name,
  version: src.version,
  type: src.type,
  sideEffects: src.sideEffects ?? false,
  // Published artifact is public; the tracked workspace copy stays `private: true`.
  private: false,
  exports: {
    ".": {
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
      default: "./dist/index.js"
    },
    "./project": {
      types: "./dist/project.d.ts",
      import: "./dist/project.js",
      default: "./dist/project.js"
    },
    "./server": {
      types: "./dist/server.d.ts",
      import: "./dist/server.js",
      default: "./dist/server.js"
    },
    "./adapters/bun": {
      types: "./dist/adapters/bun.d.ts",
      import: "./dist/adapters/bun.js",
      default: "./dist/adapters/bun.js"
    },
    "./adapters/node": {
      types: "./dist/adapters/node.d.ts",
      import: "./dist/adapters/node.js",
      default: "./dist/adapters/node.js"
    },
    "./package.json": "./package.json"
  },
  files: ["dist"],
  dependencies
}

rmSync(stageDir, { recursive: true, force: true })
mkdirSync(stageDir, { recursive: true })
cpSync(distDir, join(stageDir, "dist"), { recursive: true })
writeFileSync(join(stageDir, "package.json"), JSON.stringify(publishPkg, null, 2) + "\n")

console.log(`[prepare-publish] staged ${src.name}@${src.version} -> ${stageDir}`)
console.log(`[prepare-publish] exports -> dist (entrypoints-only); pack with:  npm pack ${stageDir}`)
