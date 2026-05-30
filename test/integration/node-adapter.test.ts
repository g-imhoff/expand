import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Effect, ManagedRuntime, Layer, Stream, SubscriptionRef } from "effect"
import { BunServices } from "@effect/platform-bun"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ProjectStore } from "@yodea/client-core"
import { ProjectStoreLayer } from "@yodea/client-core/project-store"
import { makeNodeAdapter } from "@yodea/client-core/adapters/node"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yodea-node-"))
  process.env.YODEA_HOME = dir
})
afterEach(() => {
  delete process.env.YODEA_HOME
  rmSync(dir, { recursive: true, force: true })
})

// The Node adapter must spawn the backend via child_process and connect over the
// ws-package WebSocket. We point its backendCommand at the source entry run by bun.
describe("Node adapter", () => {
  it("spawns + connects + creates via ws transport", async () => {
    const adapter = makeNodeAdapter({
      backendCommand: ["bun", join(process.cwd(), "apps/cli/cli/main.ts"), "server"]
    })
    const rt = ManagedRuntime.make(ProjectStoreLayer(adapter).pipe(Layer.provide(BunServices.layer)))
    try {
      const store = await rt.runPromise(ProjectStore)
      // Begin watching the ref BEFORE the create, so we can't miss the update: the
      // ref is eventually-consistent and only reflects "via-node" once the live
      // Events fold receives the server-pushed ProjectCreated over the ws transport.
      const seen = rt.runPromise(
        SubscriptionRef.changes(store.projects).pipe(
          Stream.filter((ps) => ps.some((p) => p.name === "via-node")),
          Stream.take(1),
          Stream.runDrain,
          Effect.timeout("5 seconds")
        )
      )
      const created = await rt.runPromise(store.createProject("via-node"))
      expect(created.name).toBe("via-node")
      await seen // resolves only once the live Events fold updated the ref over ws

      const list = await rt.runPromise(SubscriptionRef.get(store.projects))
      expect(list.map((p) => p.name)).toContain("via-node")
    } finally {
      await rt.dispose()
    }
  })
})
