import { existsSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import { defaultBackendEntry } from "@yodea/desktop/main/runtime"

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url))

describe("desktop default backend entry", () => {
  it("resolves to apps/server/main.ts from the bundled main module path", () => {
    const bundleUrl = pathToFileURL(join(repoRoot, "apps/desktop/out/main/index.mjs")).href
    const entry = defaultBackendEntry(bundleUrl)
    expect(entry).toBe(join(repoRoot, "apps/server/main.ts"))
    expect(existsSync(entry)).toBe(true)
  })

  it("resolves to apps/server/main.ts from the source module path", () => {
    const srcUrl = pathToFileURL(join(repoRoot, "apps/desktop/src/main/runtime.ts")).href
    expect(defaultBackendEntry(srcUrl)).toBe(join(repoRoot, "apps/server/main.ts"))
  })
})
