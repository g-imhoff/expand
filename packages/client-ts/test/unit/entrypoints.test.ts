// Pins the scoped public entrypoints (2026-07-09 scoped-entrypoints design spec):
// /project and /server are importable subpaths carrying their domain surface.
import { describe, expect, it } from "vitest"
import * as project from "@expand/client-ts/project"
import * as server from "@expand/client-ts/server"

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
})
