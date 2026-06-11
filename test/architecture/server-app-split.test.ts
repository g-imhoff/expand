import { readFileSync, existsSync } from "node:fs"
import { describe, expect, it } from "vitest"

const read = (path: string) => readFileSync(path, "utf8")

describe("server app split", () => {
  it("has a dedicated server entrypoint outside the CLI command tree", () => {
    expect(existsSync("apps/server/main.ts")).toBe(true)
    expect(read("apps/cli/cli/main.ts")).not.toContain("serverCommand")
    expect(existsSync("apps/cli/cli/commands/server.ts")).toBe(false)
  })

  it("builds CLI and server as separate binaries", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> }
    expect(pkg.scripts["build:cli"]).toContain("apps/cli/cli/main.ts")
    expect(pkg.scripts["build:server"]).toContain("apps/server/main.ts")
    expect(pkg.scripts.build).toContain("build:cli")
    expect(pkg.scripts.build).toContain("build:server")
  })

  it("keeps the compiled-binary smoke inside cert:cli:build", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> }
    expect(pkg.scripts["cert:cli:build"]).toContain("bun run build")
    expect(pkg.scripts["cert:cli:build"]).toContain("binary-smoke.sh")
  })

  it("does not keep a dependency-cruiser exception for CLI booting backend composition", () => {
    const config = read(".dependency-cruiser.cjs")
    expect(config).not.toContain("composition-only-from-server-subcommand")
    expect(config).not.toContain("apps/cli/cli/commands/server")
  })
})
