import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Effect, Fiber, Layer, ManagedRuntime, Option, Stream, SubscriptionRef } from "effect"
import { BunServices } from "@effect/platform-bun"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AppContext, makeAppContext } from "@expand/contracts/app-context"
import { Project } from "@expand/contracts/project"
import {
  runProjectSync,
  type ProjectSnapshot,
  type ProjectSyncSink
} from "@expand/contracts/project-sync"
import { makeBunAdapter } from "../../adapters/bun"
import { ClientLayer } from "../../client-layer"
import { ClientSession } from "../../client-session"
import { ProjectClient } from "../../project/client"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "expand-project-sync-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe.sequential("ProjectSync integration", () => {
  it("folds a mutation from one client into another client's sink", async () => {
    const adapter = makeBunAdapter({
      backendCommand: [process.execPath, join(process.cwd(), "apps/server/main.ts")]
    })
    const layer = ClientLayer(adapter).pipe(
      Layer.provide(BunServices.layer),
      Layer.provide(Layer.succeed(AppContext, makeAppContext(dir)))
    )
    const runtimeA = ManagedRuntime.make(layer)
    const runtimeB = ManagedRuntime.make(layer)
    let syncFiber: Fiber.Fiber<never, unknown> | undefined

    try {
      const clientA = await runtimeA.runPromise(ProjectClient)
      const clientB = await runtimeB.runPromise(ProjectClient)
      const sessionB = await runtimeB.runPromise(ClientSession)
      const snapshots: Array<ProjectSnapshot> = []
      const sink: ProjectSyncSink = {
        snapshot: (snapshot) => snapshots.push(snapshot),
        status: () => undefined
      }
      const source = {
        status: SubscriptionRef.changes(sessionB.status),
        list: () => clientB.list({ includeArchived: true }),
        events: ({ fromSeq }: { readonly fromSeq: number }) => clientB.events({ fromSeq })
      }

      syncFiber = runtimeB.runFork(runProjectSync(source, sink))
      await vi.waitFor(() => expect(snapshots.length).toBeGreaterThan(0), { timeout: 10_000 })
      const baseline = snapshots.at(-1)!
      const nextEvent = runtimeA.runFork(
        clientA.events({ fromSeq: baseline.seq }).pipe(
          Stream.runHead,
          Effect.map(Option.getOrThrow)
        )
      )
      const created = await runtimeA.runPromise(
        clientA.create({ name: "sync-integration", ensure: false })
      )
      const sequenced = await Effect.runPromise(Fiber.join(nextEvent))

      await vi.waitFor(
        () => expect(snapshots.some((snapshot) => snapshot.seq === sequenced.seq)).toBe(true),
        { timeout: 10_000 }
      )
      const reached = snapshots.find((snapshot) => snapshot.seq === sequenced.seq)!

      expect(reached).toEqual({
        projects: Project.foldList(baseline.projects, sequenced.event),
        seq: sequenced.seq
      })
      expect(reached.projects).toContainEqual(created.project)
    } finally {
      if (syncFiber !== undefined) {
        await Effect.runPromise(Fiber.interrupt(syncFiber))
      }
      await runtimeB.dispose()
      await runtimeA.dispose()
    }
  })
})
