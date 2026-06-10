import { describe, expect, it } from "vitest"
import React from "react"
import { render } from "ink-testing-library"
import { Effect, Layer, ManagedRuntime, Stream, SubscriptionRef } from "effect"
import { ProjectStore } from "@yodea/client-core"
import { RuntimeContext } from "@yodea/tui/runtime"
import { App } from "@yodea/tui/components/app"

const fakeLayer = (ref: SubscriptionRef.SubscriptionRef<ReadonlyArray<any>>) =>
  Layer.succeed(ProjectStore, {
    projects: ref,
    events: Stream.empty,
    snapshot: Effect.map(SubscriptionRef.get(ref), (projects) => ({ projects, seq: 0 })),
    createProject: (name: string) => {
      const project = { id: `id-${name}`, name, directory: null, description: null, tags: [], archived: false, createdAt: "t", updatedAt: "t" }
      return SubscriptionRef.update(ref, (cur) => [...cur, project]).pipe(Effect.as(project))
    },
    renameProject: (id: string, name: string) =>
      SubscriptionRef.updateAndGet(ref, (cur) => cur.map((p) => (p.id === id ? { ...p, name } : p))).pipe(
        Effect.map((cur) => cur.find((p) => p.id === id)!)
      ),
    changeDirectory: (id: string, directory: string) =>
      SubscriptionRef.updateAndGet(ref, (cur) => cur.map((p) => (p.id === id ? { ...p, directory } : p))).pipe(
        Effect.map((cur) => cur.find((p) => p.id === id)!)
      ),
    archiveProject: (id: string) =>
      SubscriptionRef.updateAndGet(ref, (cur) => cur.map((p) => (p.id === id ? { ...p, archived: true } : p))).pipe(
        Effect.map((cur) => cur.find((p) => p.id === id)!)
      ),
    restoreProject: (id: string) =>
      SubscriptionRef.updateAndGet(ref, (cur) => cur.map((p) => (p.id === id ? { ...p, archived: false } : p))).pipe(
        Effect.map((cur) => cur.find((p) => p.id === id)!)
      ),
    setMetadata: (id: string, patch: { description?: string | null; tags?: ReadonlyArray<string> }) =>
      SubscriptionRef.updateAndGet(ref, (cur) => cur.map((p) => (p.id === id ? { ...p, ...patch } : p))).pipe(
        Effect.map((cur) => cur.find((p) => p.id === id)!)
      ),
    deleteProject: (id: string) =>
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
      await Effect.runPromise(SubscriptionRef.update(ref, () => [{ id: "x", name: "live-one", createdAt: "t" }]))
      await new Promise((r) => setTimeout(r, 50))
      expect(lastFrame()).toContain("live-one")
      expect(lastFrame()).toContain("Projects (1)")
    } finally {
      await runtime.dispose()
    }
  })
})
