import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Effect, ManagedRuntime, Layer, Stream, SubscriptionRef } from "effect"
import { BunServices } from "@effect/platform-bun"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ProjectStore } from "@expand/client-core"
import { ProjectStoreLayer } from "@expand/client-core/project-store"
import { makeBunAdapter } from "@expand/client-core/adapters/bun"
import { makeTestAppContext } from "@expand/contracts/app-context.testkit"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "expand-bun-spawn-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("Bun adapter (explicit backendCommand)", () => {
  it("spawns the real backend + reflects a create in the live ref", async () => {
    const adapter = makeBunAdapter({
      backendCommand: [process.execPath, join(process.cwd(), "apps/server/main.ts")]
    })
    const rt = ManagedRuntime.make(
      ProjectStoreLayer(adapter).pipe(Layer.provide(BunServices.layer), Layer.provide(makeTestAppContext(dir).layer))
    )
    try {
      const store = await rt.runPromise(ProjectStore)
      const seen = rt.runPromise(
        SubscriptionRef.changes(store.projects).pipe(
          Stream.filter((ps) => ps.some((p) => p.name === "spawned")),
          Stream.take(1),
          Stream.runDrain,
          Effect.timeout("5 seconds")
        )
      )
      const created = await rt.runPromise(store.createProject("spawned"))
      expect(created.name).toBe("spawned")
      await seen

      const list = await rt.runPromise(SubscriptionRef.get(store.projects))
      expect(list.map((p) => p.name)).toContain("spawned")
    } finally {
      await rt.dispose()
    }
  })
})
