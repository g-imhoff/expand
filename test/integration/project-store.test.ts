import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Effect, Fiber, ManagedRuntime, Layer, SubscriptionRef, Stream } from "effect"
import { BunServices } from "@effect/platform-bun"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ProjectStore } from "@yodea/client-core"
import { ProjectStoreLayer } from "@yodea/client-core/project-store"
import { bunAdapter } from "@yodea/client-core/adapters/bun"

let dir: string
let bunMainBefore: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yodea-store-"))
  process.env.YODEA_HOME = dir
  // Under vitest, Bun.main is the vitest worker, so the Bun adapter's
  // from-source spawn would launch the worker instead of the backend. Point it
  // at the real CLI entry so spawnBackend boots a working `yodea server` exactly
  // as it does in dev-from-source. Restored in afterEach.
  bunMainBefore = (Bun as unknown as { main: string }).main
  ;(Bun as unknown as { main: string }).main = join(process.cwd(), "apps/cli/cli/main.ts")
})
afterEach(() => {
  ;(Bun as unknown as { main: string }).main = bunMainBefore
  delete process.env.YODEA_HOME
  rmSync(dir, { recursive: true, force: true })
})

// Two independent stores attach to the SAME backend (one is discovered/spawned,
// the other reuses it). A create through store A must appear in store B live via
// the Events stream — the one-backend-many-frontends payoff.
describe("ProjectStore", () => {
  it("snapshot + live cross-store updates", async () => {
    const appLayer = ProjectStoreLayer(bunAdapter).pipe(Layer.provide(BunServices.layer))
    const rtA = ManagedRuntime.make(appLayer)
    const rtB = ManagedRuntime.make(appLayer)
    try {
      const storeA = await rtA.runPromise(ProjectStore)
      const storeB = await rtB.runPromise(ProjectStore)

      // Let B's forked Events subscription register on the server before A
      // publishes — the unbounded PubSub only delivers events emitted AFTER a
      // subscription attaches, so a create racing B's attach would be missed.
      await new Promise((r) => setTimeout(r, 500))

      // Wait until B's live stream reflects a create done via A.
      const seen = rtB.runPromise(
        SubscriptionRef.changes(storeB.projects).pipe(
          Stream.filter((ps) => ps.some((p) => p.name === "alpha")),
          Stream.take(1),
          Stream.runCollect
        )
      )
      const created = await rtA.runPromise(storeA.createProject("alpha"))
      expect(created.name).toBe("alpha")
      await seen // resolves only once B observed "alpha" via Events

      const listB = await rtB.runPromise(SubscriptionRef.get(storeB.projects))
      expect(listB.map((p) => p.name)).toContain("alpha")
    } finally {
      await rtA.dispose()
      await rtB.dispose()
    }
  })

  it("renameProject updates the reactive projects ref via the live fold", async () => {
    const appLayer = ProjectStoreLayer(bunAdapter).pipe(Layer.provide(BunServices.layer))
    const rt = ManagedRuntime.make(appLayer)
    try {
      const store = await rt.runPromise(ProjectStore)
      const created = await rt.runPromise(store.createProject("alpha"))
      await rt.runPromise(store.renameProject(created.id, "alpha-renamed"))
      // allow the Events fold loop to apply (mirror the settle the file uses)
      await new Promise((r) => setTimeout(r, 300))
      const snapshot = await rt.runPromise(SubscriptionRef.get(store.projects))
      expect(snapshot.find((p) => p.id === created.id)?.name).toBe("alpha-renamed")
    } finally {
      await rt.dispose()
    }
  })

  it("exposes a live events stream that emits ProjectCreated", async () => {
    const appLayer = ProjectStoreLayer(bunAdapter).pipe(Layer.provide(BunServices.layer))
    const rt = ManagedRuntime.make(appLayer)
    try {
      const store = await rt.runPromise(ProjectStore)
      // subscribe BEFORE the create so the live (post-subscription) event is seen
      const seen = rt.runPromise(
        store.events.pipe(
          Stream.filter((e) => e._tag === "ProjectCreated" && e.name === "gamma"),
          Stream.take(1),
          Stream.runCollect
        )
      )
      await new Promise((r) => setTimeout(r, 300))
      await rt.runPromise(store.createProject("gamma"))
      const events = await seen
      expect(Array.from(events)[0]).toMatchObject({ _tag: "ProjectCreated", name: "gamma" })
    } finally {
      await rt.dispose()
    }
  })
})
