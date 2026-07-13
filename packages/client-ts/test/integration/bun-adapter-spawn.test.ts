import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ManagedRuntime, Layer } from "effect"
import { BunServices } from "@effect/platform-bun"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ProjectClient, ProjectClientLayer } from "../../project/client"
import { makeBunAdapter } from "../../adapters/bun"
import { AppContext, makeAppContext } from "@expand/contracts/app-context"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "expand-bun-spawn-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("Bun adapter (explicit backendCommand)", () => {
  it("spawns the real backend and creates through ProjectClient", async () => {
    const adapter = makeBunAdapter({
      backendCommand: [process.execPath, join(process.cwd(), "apps/server/main.ts")]
    })
    const rt = ManagedRuntime.make(
      ProjectClientLayer(adapter).pipe(Layer.provide(BunServices.layer), Layer.provide(Layer.succeed(AppContext, makeAppContext(dir))))
    )
    try {
      const client = await rt.runPromise(ProjectClient)
      const created = await rt.runPromise(client.create({ name: "spawned", ensure: false }))
      expect(created.project.name).toBe("spawned")

      const list = await rt.runPromise(client.list({ includeArchived: true }))
      expect(list.projects.map((project) => project.name)).toContain("spawned")
    } finally {
      await rt.dispose()
    }
  })
})
