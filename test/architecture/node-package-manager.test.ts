import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const root = join(import.meta.dirname, "..", "..")
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
const architecturePkg = JSON.parse(
  readFileSync(join(root, "docs", "architecture", "package.json"), "utf8"),
)

describe("Node and npm baseline", () => {
  it("pins a supported Node 24 LTS release and npm 11", () => {
    expect(readFileSync(join(root, ".node-version"), "utf8").trim()).toBe("24.17.0")
    expect(pkg.engines).toEqual({ node: ">=24.15", npm: ">=11" })
    expect(pkg.packageManager).toMatch(/^npm@11\./)
  })

  it("pins the Effect shared platform package to the retained beta", () => {
    expect(pkg.overrides).toEqual({ "@effect/platform-node-shared": "4.0.0-beta.74" })
  })

  it("retains the existing LikeC4 version", () => {
    expect(architecturePkg.devDependencies.likec4).toBe("1.56.0")
  })

  it("uses npm-compatible workspace dependency ranges", () => {
    expect(pkg.dependencies["@expand/contracts"]).toBe("0.0.0")
    expect(pkg.dependencies["@expand/client-ts"]).toBe("0.0.0")
  })
})
