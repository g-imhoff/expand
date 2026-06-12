import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Effect, ManagedRuntime, Layer, Stream, SubscriptionRef } from "effect"
import { BunServices } from "@effect/platform-bun"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ProjectStore } from "@yodea/client-core"
import { ProjectStoreLayer } from "@yodea/client-core/project-store"
import { makeNodeAdapter } from "@yodea/client-core/adapters/node"
import { ProjectName } from "@yodea/contracts/project"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yodea-node-"))
  process.env.YODEA_HOME = dir
  process.env.YODEA_DB = join(dir, "events.db")
})
afterEach(() => {
  delete process.env.YODEA_HOME
  delete process.env.YODEA_DB
  rmSync(dir, { recursive: true, force: true })
})

describe("Node adapter", () => {
  it("spawns + connects + creates via ws transport", async () => {
    const adapter = makeNodeAdapter({
      backendCommand: ["bun", join(process.cwd(), "apps/server/main.ts")]
    })
    const rt = ManagedRuntime.make(ProjectStoreLayer(adapter).pipe(Layer.provide(BunServices.layer)))
    try {
      const store = await rt.runPromise(ProjectStore)
      const seen = rt.runPromise(
        SubscriptionRef.changes(store.projects).pipe(
          Stream.filter((ps) => ps.some((p) => p.name === "via-node")),
          Stream.take(1),
          Stream.runDrain,
          Effect.timeout("5 seconds")
        )
      )
      const created = await rt.runPromise(store.createProject(ProjectName.make("via-node")))
      expect(created.name).toBe("via-node")
      await seen

      const list = await rt.runPromise(SubscriptionRef.get(store.projects))
      expect(list.map((p) => p.name)).toContain("via-node")
    } finally {
      await rt.dispose()
    }
  })
})
