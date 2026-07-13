import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Layer, ManagedRuntime, SubscriptionRef } from "effect"
import { NodeServices } from "@effect/platform-node"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout } from "node:timers/promises"
import { ProjectStore } from "../../project/store"
import { ProjectStoreLayer } from "../../project/store"
import { makeNodeAdapter } from "../../adapters/node"
import { AppContext, makeAppContext } from "@expand/contracts/app-context"

let dir: string
const nodeAdapter = makeNodeAdapter({
  backendCommand: [process.execPath, "--import", "tsx", join(process.cwd(), "apps/server/main.ts")]
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "expand-reconnect-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const waitFor = async (predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`)
    await setTimeout(25)
  }
}

describe("ProjectStore reconnect", () => {
  it("recovers after the backend dies: status leaves connected, then a mutation and the list succeed", async () => {
    const rt = ManagedRuntime.make(
      ProjectStoreLayer(nodeAdapter).pipe(Layer.provide(NodeServices.layer), Layer.provide(Layer.succeed(AppContext, makeAppContext(dir))))
    )
    try {
      const store = await rt.runPromise(ProjectStore)
      const status = () => rt.runPromise(SubscriptionRef.get(store.status))
      expect(await status()).toBe("connected")

      const created = await rt.runPromise(store.createProject("before-kill"))
      expect(created.name).toBe("before-kill")

      const endpoint = JSON.parse(readFileSync(join(dir, "server.json"), "utf8")) as { pid: number }
      process.kill(endpoint.pid)

      await waitFor(async () => (await status()) !== "connected", 10_000)
      await waitFor(async () => (await status()) === "connected", 20_000)

      const after = await rt.runPromise(store.createProject("after-kill"))
      expect(after.name).toBe("after-kill")

      await waitFor(async () => {
        const names = (await rt.runPromise(SubscriptionRef.get(store.projects))).map((p): string => p.name)
        return names.includes("before-kill") && names.includes("after-kill")
      }, 10_000)
    } finally {
      await rt.dispose()
    }
  }, 60_000)
})
