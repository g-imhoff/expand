import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ManagedRuntime, Layer } from "effect"
import { NodeServices } from "@effect/platform-node"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ProjectClient, ProjectClientLayer } from "../../project/client"
import { makeNodeAdapter } from "../../adapters/node"
import { AppContext, makeAppContext } from "@expand/contracts/app-context"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "expand-node-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("Node adapter", () => {
  it("spawns + connects + creates via ws transport", async () => {
    const adapter = makeNodeAdapter({
      backendCommand: [process.execPath, "--import", "tsx", join(process.cwd(), "apps/server/main.ts")]
    })
    const rt = ManagedRuntime.make(
      ProjectClientLayer(adapter).pipe(
        Layer.provide(NodeServices.layer),
        Layer.provide(Layer.succeed(AppContext, makeTestAppContext(dir)))
      )
    )
    try {
      const client = await rt.runPromise(ProjectClient)
      const created = await rt.runPromise(client.create({ name: "via-node", ensure: false }))
      expect(created.project.name).toBe("via-node")

      const list = await rt.runPromise(client.list({ includeArchived: true }))
      expect(list.projects.map((project) => project.name)).toContain("via-node")
    } finally {
      await rt.dispose()
    }
  })
})

const makeTestAppContext = (dataDir: string) =>
  makeAppContext(
    { join, resolve: (...paths) => paths[paths.length - 1] ?? "" },
    { homeDir: dataDir, cwd: dataDir, dataDir }
  )
