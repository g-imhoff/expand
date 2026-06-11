import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Layer, ManagedRuntime, SubscriptionRef } from "effect"
import { BunServices } from "@effect/platform-bun"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ProjectStore } from "@yodea/client-core"
import { ProjectName } from "@yodea/contracts/project"
import { ProjectStoreLayer } from "@yodea/client-core/project-store"
import { bunAdapter } from "@yodea/client-core/adapters/bun"

let dir: string
let bunMainBefore: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yodea-reconnect-"))
  process.env.YODEA_HOME = dir
  process.env.YODEA_DB = join(dir, "events.db")
  bunMainBefore = (Bun as unknown as { main: string }).main
  ;(Bun as unknown as { main: string }).main = join(process.cwd(), "apps/server/main.ts")
})
afterEach(() => {
  ;(Bun as unknown as { main: string }).main = bunMainBefore
  delete process.env.YODEA_HOME
  delete process.env.YODEA_DB
  rmSync(dir, { recursive: true, force: true })
})

const waitFor = async (predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe("ProjectStore reconnect", () => {
  it("recovers after the backend dies: status leaves connected, then a mutation and the list succeed", async () => {
    const rt = ManagedRuntime.make(ProjectStoreLayer(bunAdapter).pipe(Layer.provide(BunServices.layer)))
    try {
      const store = await rt.runPromise(ProjectStore)
      const status = () => rt.runPromise(SubscriptionRef.get(store.status))
      expect(await status()).toBe("connected")

      const created = await rt.runPromise(store.createProject(ProjectName.make("before-kill")))
      expect(created.name).toBe("before-kill")

      const endpoint = JSON.parse(readFileSync(join(dir, "server.json"), "utf8")) as { pid: number }
      process.kill(endpoint.pid)

      await waitFor(async () => (await status()) !== "connected", 10_000)
      await waitFor(async () => (await status()) === "connected", 20_000)

      const after = await rt.runPromise(store.createProject(ProjectName.make("after-kill")))
      expect(after.name).toBe("after-kill")

      await waitFor(async () => {
        const names = (await rt.runPromise(SubscriptionRef.get(store.projects))).map((p) => p.name)
        return names.includes(ProjectName.make("before-kill")) && names.includes(ProjectName.make("after-kill"))
      }, 10_000)
    } finally {
      await rt.dispose()
    }
  }, 60_000)
})
