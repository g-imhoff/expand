import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ManagedRuntime, Layer, SubscriptionRef, Stream } from "effect"
import { BunServices } from "@effect/platform-bun"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ProjectStore } from "@yodea/client-core"
import { ProjectStoreLayer } from "@yodea/client-core/project-store"
import { bunAdapter } from "@yodea/client-core/adapters/bun"
import { ProjectName } from "@yodea/contracts/project"

let dir: string
let bunMainBefore: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yodea-xstore-"))
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

describe("cross-store live sync", () => {
  it("a rename through store A appears in store B via the live event-fold", async () => {
    const appLayer = ProjectStoreLayer(bunAdapter).pipe(Layer.provide(BunServices.layer))
    const rtA = ManagedRuntime.make(appLayer)
    const rtB = ManagedRuntime.make(appLayer)
    try {
      const storeA = await rtA.runPromise(ProjectStore)
      const storeB = await rtB.runPromise(ProjectStore)
      await new Promise((r) => setTimeout(r, 500))

      const created = await rtA.runPromise(storeA.createProject(ProjectName.make("sync-me")))
      await rtB.runPromise(
        SubscriptionRef.changes(storeB.projects).pipe(
          Stream.filter((ps) => ps.some((p) => p.id === created.id)),
          Stream.take(1), Stream.runCollect
        )
      )
      const sawRename = rtB.runPromise(
        SubscriptionRef.changes(storeB.projects).pipe(
          Stream.filter((ps) => ps.some((p) => p.id === created.id && p.name === "sync-renamed")),
          Stream.take(1), Stream.runCollect
        )
      )
      await rtA.runPromise(storeA.renameProject(created.id, ProjectName.make("sync-renamed")))
      await sawRename

      const listB = await rtB.runPromise(SubscriptionRef.get(storeB.projects))
      expect(listB.find((p) => p.id === created.id)?.name).toBe("sync-renamed")
    } finally {
      await rtA.dispose()
      await rtB.dispose()
    }
  })

  it("an archive then a delete through store A both propagate to store B", async () => {
    const appLayer = ProjectStoreLayer(bunAdapter).pipe(Layer.provide(BunServices.layer))
    const rtA = ManagedRuntime.make(appLayer)
    const rtB = ManagedRuntime.make(appLayer)
    try {
      const storeA = await rtA.runPromise(ProjectStore)
      const storeB = await rtB.runPromise(ProjectStore)
      await new Promise((r) => setTimeout(r, 500))

      const created = await rtA.runPromise(storeA.createProject(ProjectName.make("xstore-archdel")))
      await rtB.runPromise(
        SubscriptionRef.changes(storeB.projects).pipe(
          Stream.filter((ps) => ps.some((p) => p.id === created.id)),
          Stream.take(1), Stream.runCollect
        )
      )
      const sawArchived = rtB.runPromise(
        SubscriptionRef.changes(storeB.projects).pipe(
          Stream.filter((ps) => ps.some((p) => p.id === created.id && p.archived === true)),
          Stream.take(1), Stream.runCollect
        )
      )
      await rtA.runPromise(storeA.archiveProject(created.id))
      await sawArchived

      const sawGone = rtB.runPromise(
        SubscriptionRef.changes(storeB.projects).pipe(
          Stream.filter((ps) => !ps.some((p) => p.id === created.id)),
          Stream.take(1), Stream.runCollect
        )
      )
      const del = await rtA.runPromise(storeA.deleteProject(created.id))
      expect(del).toEqual({ id: created.id, deleted: true })
      await sawGone

      const listB = await rtB.runPromise(SubscriptionRef.get(storeB.projects))
      expect(listB.some((p) => p.id === created.id)).toBe(false)
    } finally {
      await rtA.dispose()
      await rtB.dispose()
    }
  })
})
