import { describe, expect, it } from "vitest"
import { Effect, Layer, ManagedRuntime, PubSub, Stream, SubscriptionRef } from "effect"
import type { Project } from "@yodea/contracts/project"
import { Project as ProjectClass, ProjectId, ProjectName, Tag } from "@yodea/contracts/project"
import type { SequencedEvent } from "@yodea/contracts/events/domain"
import { ProjectStore, type ConnectionStatus } from "@yodea/client-core"
import { connectPort } from "@yodea/desktop/main/rpc/transport"

const uid = (n: number): string => "00000000-0000-4000-8000-" + String(n).padStart(12, "0")

const makePort = () => {
  const sent: Array<unknown> = []
  let handler: ((e: { data: unknown }) => void) | undefined
  let started = false
  return {
    port: {
      postMessage: (m: unknown) => sent.push(m),
      on: (_ev: "message", cb: (e: { data: unknown }) => void) => { handler = cb },
      start: () => { started = true }
    },
    sent,
    inject: (data: unknown) => handler?.({ data }),
    isStarted: () => started,
    hasHandler: () => handler !== undefined
  }
}

const fakeStoreLayer = (
  ref: SubscriptionRef.SubscriptionRef<ReadonlyArray<Project>>,
  hub: PubSub.PubSub<SequencedEvent>
) =>
  Layer.succeed(ProjectStore, {
    projects: ref,
    status: Effect.runSync(SubscriptionRef.make<ConnectionStatus>("connected")),
    events: Stream.fromPubSub(hub),
    snapshot: Effect.map(SubscriptionRef.get(ref), (projects) => ({ projects, seq: 0 })),
    createProject: (name: string) => {
      const p = ProjectClass.make({ id: ProjectId.make(uid(1)), name: ProjectName.make(name as ProjectName), directory: null, description: null, tags: [], archived: false, createdAt: "t", updatedAt: "t" })
      return SubscriptionRef.update(ref, (c) => [...c, p]).pipe(Effect.as(p))
    },
    renameProject: (id: ProjectId, name: string) =>
      SubscriptionRef.updateAndGet(ref, (c) => c.map((p) => (p.id === id ? ProjectClass.make({ ...p, name: ProjectName.make(name as ProjectName) }) : p))).pipe(
        Effect.map((c) => c.find((p) => p.id === id)!)
      ),
    changeDirectory: (id: ProjectId, directory: string) =>
      SubscriptionRef.updateAndGet(ref, (c) => c.map((p) => (p.id === id ? ProjectClass.make({ ...p, directory }) : p))).pipe(
        Effect.map((c) => c.find((p) => p.id === id)!)
      ),
    archiveProject: (id: ProjectId) =>
      SubscriptionRef.updateAndGet(ref, (c) => c.map((p) => (p.id === id ? ProjectClass.make({ ...p, archived: true }) : p))).pipe(
        Effect.map((c) => c.find((p) => p.id === id)!)
      ),
    restoreProject: (id: ProjectId) =>
      SubscriptionRef.updateAndGet(ref, (c) => c.map((p) => (p.id === id ? ProjectClass.make({ ...p, archived: false }) : p))).pipe(
        Effect.map((c) => c.find((p) => p.id === id)!)
      ),
    setMetadata: (id: ProjectId, patch: { description?: string | null; tags?: ReadonlyArray<Tag> }) =>
      SubscriptionRef.updateAndGet(ref, (c) => c.map((p) => (p.id === id ? ProjectClass.make({ ...p, ...patch }) : p))).pipe(
        Effect.map((c) => c.find((p) => p.id === id)!)
      ),
    deleteProject: (id: ProjectId) =>
      SubscriptionRef.update(ref, (c) => c.filter((p) => p.id !== id)).pipe(
        Effect.as({ id, deleted: true } as const)
      )
  })

describe("connectPort", () => {
  it("wires the port (start + message handler) and returns a working teardown", async () => {
    const ref = await Effect.runPromise(SubscriptionRef.make<ReadonlyArray<Project>>([]))
    const hub = await Effect.runPromise(PubSub.unbounded<SequencedEvent>())
    const runtime = ManagedRuntime.make(fakeStoreLayer(ref, hub))
    const p = makePort()
    try {
      const teardown = connectPort({ port: p.port, runtime })
      await new Promise((r) => setTimeout(r, 50))
      expect(p.isStarted()).toBe(true)
      expect(p.hasHandler()).toBe(true)
      expect(typeof teardown).toBe("function")
      await teardown()
    } finally {
      await runtime.dispose()
    }
  })
})
