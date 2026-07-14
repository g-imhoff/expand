import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Effect, Fiber, Layer, ManagedRuntime, Option, Stream, SubscriptionRef } from "effect"
import { ProcessServices } from "../process-services"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { AppContext, makeAppContext } from "@expand/contracts/app-context"
import { Project } from "@expand/contracts/project"
import {
  runProjectSync,
  type ProjectSnapshot,
  type ProjectSyncSink
} from "@expand/contracts/project-sync"
import { makeNodeAdapter } from "../../adapters/node"
import { ClientLayer } from "../../client-layer"
import { ClientSession } from "../../client-session"
import { ProjectClient } from "../../project/client"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "expand-project-sync-"))
})

afterEach(() => {
  const pid = endpointPid()
  if (pid !== undefined) {
    try {
      process.kill(pid, "SIGTERM")
    } catch {}
  }
  rmSync(dir, { recursive: true, force: true })
})

const endpointPid = (): number | undefined => {
  const endpoint = join(dir, "server.json")
  if (!existsSync(endpoint)) return undefined
  try {
    return (JSON.parse(readFileSync(endpoint, "utf8")) as { readonly pid?: number }).pid
  } catch {
    return undefined
  }
}

describe.sequential("ProjectSync integration", () => {
  it("folds a mutation from one client into another client's sink", async () => {
    const adapter = makeNodeAdapter({
      backendCommand: Effect.sync(() => ["node", "--import", "tsx", resolve("apps/server/main.ts")])
    })
    const layer = ClientLayer(adapter).pipe(
      Layer.provide(ProcessServices.layer),
      Layer.provide(Layer.succeed(AppContext, makeTestAppContext(dir)))
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

  it("resnapshots after ClientLayer kills and reacquires the backend", async () => {
    const adapter = makeNodeAdapter({
      backendCommand: Effect.sync(() => ["node", "--import", "tsx", resolve("apps/server/main.ts")])
    })
    const layer = ClientLayer(adapter).pipe(
      Layer.provide(ProcessServices.layer),
      Layer.provide(Layer.succeed(AppContext, makeTestAppContext(dir)))
    )
    const runtime = ManagedRuntime.make(layer)
    let syncFiber: Fiber.Fiber<never, unknown> | undefined

    try {
      const client = await runtime.runPromise(ProjectClient)
      const session = await runtime.runPromise(ClientSession)
      const snapshots: Array<ProjectSnapshot> = []
      const statuses: Array<string> = []
      syncFiber = runtime.runFork(
        runProjectSync(
          {
            status: SubscriptionRef.changes(session.status),
            list: () => client.list({ includeArchived: true }),
            events: ({ fromSeq }) => client.events({ fromSeq })
          },
          {
            snapshot: (snapshot) => snapshots.push(snapshot),
            status: (status) => statuses.push(status)
          }
        )
      )
      await vi.waitFor(() => expect(snapshots.length).toBeGreaterThan(0), { timeout: 10_000 })
      const before = await runtime.runPromise(
        client.create({ name: "before-backend-kill", ensure: false })
      )
      await vi.waitFor(
        () => expect(snapshots.at(-1)?.projects).toContainEqual(before.project),
        { timeout: 10_000 }
      )
      const firstPid = endpointPid()
      expect(firstPid).toBeTypeOf("number")
      process.kill(firstPid!, "SIGTERM")
      await vi.waitFor(() => expect(statuses).toContain("reconnecting"), { timeout: 10_000 })
      await vi.waitFor(() => expect(endpointPid()).not.toBe(firstPid), { timeout: 20_000 })
      const after = await runtime.runPromise(
        client.create({ name: "after-backend-kill", ensure: false })
      )
      await vi.waitFor(
        () => expect(snapshots.at(-1)?.projects).toContainEqual(after.project),
        { timeout: 10_000 }
      )
      expect(statuses.filter((status) => status === "connected")).toHaveLength(2)
      expect(snapshots.at(-1)?.projects).toEqual(
        expect.arrayContaining([before.project, after.project])
      )
    } finally {
      if (syncFiber !== undefined) {
        await Effect.runPromise(Fiber.interrupt(syncFiber))
      }
      await runtime.dispose()
    }
  }, 60_000)
})

const makeTestAppContext = (dataDir: string) =>
  makeAppContext(
    { join, resolve },
    { homeDir: dataDir, cwd: dataDir, dataDir }
  )

function join(...paths: ReadonlyArray<string>): string {
  return resolve(...paths)
}
