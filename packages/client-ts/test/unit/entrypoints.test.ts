// Pins the scoped public entrypoints (2026-07-09 scoped-entrypoints design spec):
// /project and /server are importable subpaths carrying their domain surface.
import { describe, expect, it } from "vitest"
import { createRequire } from "node:module"
import * as root from "@expand/client-ts"
import * as nodeAdapter from "@expand/client-ts/adapters/node"
import * as project from "@expand/client-ts/project"
import * as server from "@expand/client-ts/server"

const packageJson = createRequire(import.meta.url)("../../package.json") as {
  readonly exports: Readonly<Record<string, string>>
}

describe("scoped entrypoints", () => {
  it("@expand/client-ts/project exposes the project domain", () => {
    expect(project.ProjectStore).toBeDefined()
    expect(project.ProjectStoreLayer).toBeDefined()
    expect(project.ProjectClient).toBeDefined()
    expect(project.ProjectClientLayer).toBeDefined()
    expect(project.Project).toBeDefined()
    expect(project.ProjectNotFound).toBeDefined()
    // SequencedEvent is root stream vocabulary, not project-domain
    expect((project as Record<string, unknown>).SequencedEvent).toBeUndefined()
  })

  it("@expand/client-ts/server exposes the server domain", () => {
    expect(server.ServerClient).toBeDefined()
    expect(server.ServerClientLayer).toBeDefined()
  })

  it("root is strict core — no domain re-exports", () => {
    const r = root as Record<string, unknown>
    expect(r.ProjectStore).toBeUndefined()
    expect(r.ProjectClient).toBeUndefined()
    expect(r.ServerClient).toBeUndefined()
    expect(r.ProjectNotFound).toBeUndefined()
    expect(r.Project).toBeUndefined()
    // ...while the connection core stays
    expect(root.ClientLayer).toBeDefined()
    expect(root.withClient).toBeDefined()
    expect(root.resolveBackendCommand).toBeDefined()
    expect(root.readEndpoint).toBeDefined()
    expect(root.BackendUnavailable).toBeDefined()
    expect(root.SequencedEvent).toBeDefined()
  })

  it("exposes Node as the sole platform adapter", () => {
    expect(nodeAdapter.makeNodeAdapter).toBeDefined()
    expect(Object.keys(packageJson.exports).filter((entry) => entry.startsWith("./adapters/"))).toEqual([
      "./adapters/node"
    ])
  })
})
