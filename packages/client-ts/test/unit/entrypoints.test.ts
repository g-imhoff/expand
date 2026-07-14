// Pins the scoped public entrypoints (2026-07-09 scoped-entrypoints design spec):
// /project and /server are importable subpaths carrying their domain surface.
import { describe, expect, it } from "vitest"
import { expectTypeOf } from "vitest"
import type { Effect, FileSystem } from "effect"
import { createRequire } from "node:module"
import * as root from "@expand/client-ts"
import * as nodeAdapter from "@expand/client-ts/adapters/node"
import * as project from "@expand/client-ts/project"
import * as server from "@expand/client-ts/server"
import type {
  BackendCommandError,
  BackendUnavailable,
  ProcessStatus,
  RuntimeAdapter
} from "@expand/client-ts"

const packageJson = createRequire(import.meta.url)("../../package.json") as {
  readonly exports: Readonly<Record<string, string>>
}

describe("scoped entrypoints", () => {
  it("@expand/client-ts/project exposes the project domain", () => {
    expect(project.ProjectClient).toBeDefined()
    expect(project.ProjectClientLayer).toBeDefined()
    expect(project.Project).toBeDefined()
    expect(project.ProjectNotFound).toBeDefined()
    const p = project as Record<string, unknown>
    expect(p.ProjectStore).toBeUndefined()
    expect(p.ProjectStoreLayer).toBeUndefined()
    expect(p.SequencedEvent).toBeUndefined()
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
    expect(root.ClientSession).toBeDefined()
    expect(root.ClientSessionLayer).toBeDefined()
    expect(root.ClientLayer).toBeDefined()
    expect(root.withClient).toBeDefined()
    expect(root.resolveBackendCommand).toBeDefined()
    expect(root.readEndpoint).toBeDefined()
    expect(root.BackendCommandError).toBeDefined()
    expect(root.BackendUnavailable).toBeDefined()
    expect(root.ProcessControl).toBeDefined()
    expect(root.ProcessProbeError).toBeDefined()
    expect(root.SequencedEvent).toBeDefined()
    expectTypeOf<ProcessStatus>().toEqualTypeOf<"alive" | "dead" | "inaccessible">()
  })

  it("exposes Effect-native backend command and spawn contracts", () => {
    expectTypeOf<Parameters<typeof nodeAdapter.makeNodeAdapter>[0]["backendCommand"]>().toEqualTypeOf<
      Effect.Effect<ReadonlyArray<string>, BackendCommandError, FileSystem.FileSystem>
    >()
    expectTypeOf<ReturnType<RuntimeAdapter["spawnBackend"]>>().toEqualTypeOf<
      Effect.Effect<void, BackendUnavailable, FileSystem.FileSystem>
    >()
  })

  it("exposes Node as the sole platform adapter", () => {
    expect(nodeAdapter.makeNodeAdapter).toBeDefined()
    expect(nodeAdapter.nodeProcessControlLayer).toBeDefined()
    expect(nodeAdapter.ProcessServices).toBeDefined()
    expect(Object.keys(packageJson.exports).filter((entry) => entry.startsWith("./adapters/"))).toEqual([
      "./adapters/node"
    ])
  })
})
