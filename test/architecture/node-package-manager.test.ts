import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const root = join(import.meta.dirname, "..", "..")
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))

describe("Node and npm baseline", () => {
  it("pins Node 24 and npm 11", () => {
    expect(readFileSync(join(root, ".node-version"), "utf8").trim()).toMatch(/^24(?:\.|$)/)
    expect(pkg.engines).toEqual({ node: ">=24", npm: ">=11" })
    expect(pkg.packageManager).toMatch(/^npm@11\./)
  })

  it("uses npm-compatible workspace dependency ranges", () => {
    expect(pkg.dependencies["@expand/contracts"]).toBe("0.0.0")
    expect(pkg.dependencies["@expand/client-ts"]).toBe("0.0.0")
  })
})
