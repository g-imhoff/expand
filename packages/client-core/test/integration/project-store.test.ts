import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Effect, Fiber, ManagedRuntime, Layer, SubscriptionRef, Stream } from "effect"
import { BunServices } from "@effect/platform-bun"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ProjectStore } from "@yodea/client-core"
import { ProjectStoreLayer } from "@yodea/client-core/project-store"
import { bunAdapter } from "@yodea/client-core/adapters/bun"
import { ProjectName, Tag } from "@yodea/contracts/project"

let dir: string
let bunMainBefore: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yodea-store-"))
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

describe("ProjectStore", () => {
  it("snapshot + live cross-store updates", async () => {
    const appLayer = ProjectStoreLayer(bunAdapter).pipe(Layer.provide(BunServices.layer))
    const rtA = ManagedRuntime.make(appLayer)
    const rtB = ManagedRuntime.make(appLayer)
    try {
      const storeA = await rtA.runPromise(ProjectStore)
      const storeB = await rtB.runPromise(ProjectStore)

      await new Promise((r) => setTimeout(r, 500))

      const seen = rtB.runPromise(
        SubscriptionRef.changes(storeB.projects).pipe(
          Stream.filter((ps) => ps.some((p) => p.name === "alpha")),
          Stream.take(1),
          Stream.runCollect
        )
      )
      const created = await rtA.runPromise(storeA.createProject(ProjectName.make("alpha")))
      expect(created.name).toBe("alpha")
      await seen

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
      const created = await rt.runPromise(store.createProject(ProjectName.make("alpha")))
      await rt.runPromise(store.renameProject(created.id, ProjectName.make("alpha-renamed")))
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
      const created = await rt.runPromise(store.createProject(ProjectName.make("cdstore")))
      const moved = await rt.runPromise(store.changeDirectory(created.id, tmp))
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
      const created = await rt.runPromise(store.createProject(ProjectName.make("toggleme")))
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
    const appLayer = ProjectStoreLayer(bunAdapter).pipe(Layer.provide(BunServices.layer))
    const rtA = ManagedRuntime.make(appLayer)
    try {
      const storeA = await rtA.runPromise(ProjectStore)
      const created = await rtA.runPromise(storeA.createProject(ProjectName.make("archived-at-rest")))
      await rtA.runPromise(storeA.archiveProject(created.id))
      await new Promise((r) => setTimeout(r, 300))

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
      const seen = rt.runPromise(
        store.events.pipe(
          Stream.filter((se) => se.event._tag === "ProjectCreated" && se.event.name === "gamma"),
          Stream.take(1),
          Stream.runCollect
        )
      )
      await new Promise((r) => setTimeout(r, 300))
      await rt.runPromise(store.createProject(ProjectName.make("gamma")))
      const events = await seen
      expect(Array.from(events)[0]).toMatchObject({ event: { _tag: "ProjectCreated", name: "gamma" } })
    } finally {
      await rt.dispose()
    }
  })
  it("setMetadata mutates the reactive ref via the live fold", async () => {
    const appLayer = ProjectStoreLayer(bunAdapter).pipe(Layer.provide(BunServices.layer))
    const rt = ManagedRuntime.make(appLayer)
    try {
      const store = await rt.runPromise(ProjectStore)
      const created = await rt.runPromise(store.createProject(ProjectName.make("withmeta")))
      await rt.runPromise(store.setMetadata(created.id, { description: "desc", tags: [Tag.make("a"), Tag.make("a")] }))
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
      const created = await rtA.runPromise(storeA.createProject(ProjectName.make("toremove")))
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


