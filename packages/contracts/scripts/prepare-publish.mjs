// Produces a publish-ready staging directory (`dist-publish/`) whose package.json
// points `exports` at the built `dist/` (compiled ESM .js + .d.ts) instead of the
// in-repo source `.ts`. The tracked package.json is NEVER mutated, so in-repo
// resolution (which relies on `exports` -> source `.ts`) keeps working.
//
// Flow:  npm run build            -> tsc emits ./dist
//        node scripts/prepare-publish.mjs -> writes ./dist-publish/{package.json, dist/**}
//        npm pack ./dist-publish  -> tarball whose package.json exports resolve dist/*.js
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..")
const distDir = join(pkgDir, "dist")
const stageDir = join(pkgDir, "dist-publish")

if (!existsSync(distDir)) {
  console.error("[prepare-publish] ./dist not found — run `npm run build` first.")
  process.exit(1)
}

const src = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"))

// Publish-time package.json: source `exports` (-> ./*.ts) swapped for dist (-> ./dist/*).
const publishPkg = {
  name: src.name,
  version: src.version,
  type: src.type,
  sideEffects: src.sideEffects ?? false,
  // Published artifact is public; the tracked workspace copy stays `private: true`.
  private: false,
  exports: {
    "./events/domain-event": null,
    "./package.json": "./package.json",
    "./*": {
      types: "./dist/*.d.ts",
      import: "./dist/*.js",
      default: "./dist/*.js"
    }
  },
  files: ["dist"],
  ...(src.dependencies ? { dependencies: src.dependencies } : {})
}

rmSync(stageDir, { recursive: true, force: true })
mkdirSync(stageDir, { recursive: true })
cpSync(distDir, join(stageDir, "dist"), { recursive: true })
writeFileSync(join(stageDir, "package.json"), JSON.stringify(publishPkg, null, 2) + "\n")

console.log(`[prepare-publish] staged ${src.name}@${src.version} -> ${stageDir}`)
console.log(`[prepare-publish] exports -> dist; pack with:  npm pack ${stageDir}`)
