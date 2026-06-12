import { describe, expect, it } from "vitest"
import React from "react"
import { render } from "ink-testing-library"
import { Effect, Layer, ManagedRuntime, Stream, SubscriptionRef } from "effect"
import { ProjectStore, type ConnectionStatus } from "@yodea/client-core"
import { type ProjectId, type ProjectName, type Tag } from "@yodea/contracts/project"
import { RuntimeContext } from "@yodea/tui/runtime"
import { App } from "@yodea/tui/components/app"

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` as ProjectId

const fakeLayer = (ref: SubscriptionRef.SubscriptionRef<ReadonlyArray<any>>) =>
  Layer.succeed(ProjectStore, {
    projects: ref,
    status: Effect.runSync(SubscriptionRef.make<ConnectionStatus>("connected")),
    events: Stream.empty,
    snapshot: Effect.map(SubscriptionRef.get(ref), (projects) => ({ projects, seq: 0 })),
    createProject: (name: ProjectName) => {
      const project = { id: uid(1), name, directory: null, description: null, tags: [] as ReadonlyArray<Tag>, archived: false, createdAt: "t", updatedAt: "t" }
      return SubscriptionRef.update(ref, (cur) => [...cur, project]).pipe(Effect.as(project as any))
    },
    renameProject: (id: ProjectId, name: ProjectName) =>
      SubscriptionRef.updateAndGet(ref, (cur) => cur.map((p) => (p.id === id ? { ...p, name } : p))).pipe(
        Effect.map((cur) => cur.find((p) => p.id === id)! as any)
      ),
    changeDirectory: (id: ProjectId, directory: string) =>
      SubscriptionRef.updateAndGet(ref, (cur) => cur.map((p) => (p.id === id ? { ...p, directory } : p))).pipe(
        Effect.map((cur) => cur.find((p) => p.id === id)! as any)
      ),
    archiveProject: (id: ProjectId) =>
      SubscriptionRef.updateAndGet(ref, (cur) => cur.map((p) => (p.id === id ? { ...p, archived: true } : p))).pipe(
        Effect.map((cur) => cur.find((p) => p.id === id)! as any)
      ),
    restoreProject: (id: ProjectId) =>
      SubscriptionRef.updateAndGet(ref, (cur) => cur.map((p) => (p.id === id ? { ...p, archived: false } : p))).pipe(
        Effect.map((cur) => cur.find((p) => p.id === id)! as any)
      ),
    setMetadata: (id: ProjectId, patch: { description?: string | null; tags?: ReadonlyArray<Tag> }) =>
      SubscriptionRef.updateAndGet(ref, (cur) => cur.map((p) => (p.id === id ? { ...p, ...patch } : p))).pipe(
        Effect.map((cur) => cur.find((p) => p.id === id)! as any)
      ),
    deleteProject: (id: ProjectId) =>
      SubscriptionRef.update(ref, (cur) => cur.filter((p) => p.id !== id)).pipe(
        Effect.as({ id, deleted: true } as const)
      )
  })

describe("useProjects bridge", () => {
  it("renders store state and reflects live SubscriptionRef changes", async () => {
    const ref = await Effect.runPromise(SubscriptionRef.make<ReadonlyArray<any>>([]))
    const runtime = ManagedRuntime.make(fakeLayer(ref))
    try {
      const { lastFrame } = render(
        <RuntimeContext.Provider value={runtime as any}>
          <App />
        </RuntimeContext.Provider>
      )
      await Effect.runPromise(SubscriptionRef.update(ref, () => [{ id: uid(1), name: "live-one", createdAt: "t" }]))
      await new Promise((r) => setTimeout(r, 50))
      expect(lastFrame()).toContain("live-one")
      expect(lastFrame()).toContain("Projects (1)")
    } finally {
      await runtime.dispose()
    }
  })
})
