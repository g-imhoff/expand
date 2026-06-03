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

  it("changeDirectory updates the reactive projects ref", async () => {
    const appLayer = ProjectStoreLayer(bunAdapter).pipe(Layer.provide(BunServices.layer))
    const rt = ManagedRuntime.make(appLayer)
    const tmp = mkdtempSync(join(tmpdir(), "yodea-cds-"))
    try {
      const store = await rt.runPromise(ProjectStore)
      const created = await rt.runPromise(store.createProject("cdstore"))
      const moved = await rt.runPromise(store.changeDirectory(created.id, tmp))
      // allow the Events fold loop to apply (mirror the settle the file uses)
      await new Promise((r) => setTimeout(r, 300))
      const snapshot = await rt.runPromise(SubscriptionRef.get(store.projects))
      expect(moved.directory).toBe(tmp)
      expect(snapshot.find((p) => p.id === created.id)?.directory).toBe(tmp)
    } finally {
      await rt.dispose()
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("archive toggles archived in the live ref via the Events fold", async () => {
    const appLayer = ProjectStoreLayer(bunAdapter).pipe(Layer.provide(BunServices.layer))
    const rt = ManagedRuntime.make(appLayer)
    try {
      const store = await rt.runPromise(ProjectStore)
      await new Promise((r) => setTimeout(r, 300))
      const created = await rt.runPromise(store.createProject("toggleme"))
      const seenArchived = rt.runPromise(
        SubscriptionRef.changes(store.projects).pipe(
          Stream.filter((ps) => ps.some((p) => p.id === created.id && p.archived === true)),
          Stream.take(1),
          Stream.runCollect
        )
      )
      const archived = await rt.runPromise(store.archiveProject(created.id))
      expect(archived.archived).toBe(true)
      await seenArchived
    } finally {
      await rt.dispose()
    }
  })

  it("seeds the startup snapshot with archived projects (restore stays reachable)", async () => {
    // Regression: the snapshot must call ProjectList({ includeArchived: true }) so a
    // project archived in a prior session is present when a fresh store attaches —
    // otherwise it vanishes from the TUI/desktop list and its restore is unreachable.
    // Archive via store A, then attach store B (fresh snapshot) and assert B sees it.
    const appLayer = ProjectStoreLayer(bunAdapter).pipe(Layer.provide(BunServices.layer))
    const rtA = ManagedRuntime.make(appLayer)
    try {
      const storeA = await rtA.runPromise(ProjectStore)
      const created = await rtA.runPromise(storeA.createProject("archived-at-rest"))
      await rtA.runPromise(storeA.archiveProject(created.id))
      // let A's fold settle so the server has persisted the ProjectArchived event
      await new Promise((r) => setTimeout(r, 300))

      // Fresh store: its snapshot is a brand-new ProjectList round-trip.
      const rtB = ManagedRuntime.make(appLayer)
      try {
        const storeB = await rtB.runPromise(ProjectStore)
        const snapshot = await rtB.runPromise(SubscriptionRef.get(storeB.projects))
        const seen = snapshot.find((p) => p.id === created.id)
        expect(seen).toBeDefined()
        expect(seen?.archived).toBe(true)
      } finally {
        await rtB.dispose()
      }
    } finally {
      await rtA.dispose()
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
  it("setMetadata mutates the reactive ref via the live fold", async () => {
    const appLayer = ProjectStoreLayer(bunAdapter).pipe(Layer.provide(BunServices.layer))
    const rt = ManagedRuntime.make(appLayer)
    try {
      const store = await rt.runPromise(ProjectStore)
      const created = await rt.runPromise(store.createProject("withmeta"))
      await rt.runPromise(store.setMetadata(created.id, { description: "desc", tags: ["a", "a"] }))
      // allow the Events fold loop to apply (mirror the settle the file uses)
      await new Promise((r) => setTimeout(r, 300))
      const snapshot = await rt.runPromise(SubscriptionRef.get(store.projects))
      const p = snapshot.find((x) => x.id === created.id)
      expect(p?.description).toBe("desc")
      expect(p?.tags).toEqual(["a"])
    } finally {
      await rt.dispose()
    }
  })
  it("delete shrinks the live ref and propagates cross-store", async () => {
    const appLayer = ProjectStoreLayer(bunAdapter).pipe(Layer.provide(BunServices.layer))
    const rtA = ManagedRuntime.make(appLayer)
    const rtB = ManagedRuntime.make(appLayer)
    try {
      const storeA = await rtA.runPromise(ProjectStore)
      const storeB = await rtB.runPromise(ProjectStore)
      await new Promise((r) => setTimeout(r, 500))
      const created = await rtA.runPromise(storeA.createProject("toremove"))
      // Wait until B sees the create, then delete via A and wait for B to lose it.
      await rtB.runPromise(
        SubscriptionRef.changes(storeB.projects).pipe(
          Stream.filter((ps) => ps.some((p) => p.id === created.id)),
          Stream.take(1), Stream.runCollect
        )
      )
      const gone = rtB.runPromise(
        SubscriptionRef.changes(storeB.projects).pipe(
          Stream.filter((ps) => !ps.some((p) => p.id === created.id)),
          Stream.take(1), Stream.runCollect
        )
      )
      const result = await rtA.runPromise(storeA.deleteProject(created.id))
      expect(result).toEqual({ id: created.id, deleted: true })
      await gone
      const listB = await rtB.runPromise(SubscriptionRef.get(storeB.projects))
      expect(listB.some((p) => p.id === created.id)).toBe(false)
    } finally {
      await rtA.dispose(); await rtB.dispose()
    }
  })
})


