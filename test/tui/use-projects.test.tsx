import { describe, expect, it } from "vitest"
import React from "react"
import { render } from "ink-testing-library"
import { Effect, Layer, ManagedRuntime, Stream, SubscriptionRef } from "effect"
import { ProjectStore } from "@yodea/client-core"
import { RuntimeContext } from "@yodea/tui/runtime"
import { App } from "@yodea/tui/components/app"

// Fake ProjectStore: an in-memory SubscriptionRef + a createProject that appends.
const fakeLayer = (ref: SubscriptionRef.SubscriptionRef<ReadonlyArray<any>>) =>
  Layer.succeed(ProjectStore, {
    projects: ref,
    events: Stream.empty,
    createProject: (name: string) => {
      const project = { id: `id-${name}`, name, directory: null, description: null, tags: [], archived: false, createdAt: "t", updatedAt: "t" }
      return SubscriptionRef.update(ref, (cur) => [...cur, project]).pipe(Effect.as(project))
    },
    renameProject: (id: string, name: string) =>
      SubscriptionRef.updateAndGet(ref, (cur) => cur.map((p) => (p.id === id ? { ...p, name } : p))).pipe(
        Effect.map((cur) => cur.find((p) => p.id === id)!)
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
      // Push a change through the SAME ref the store exposes; the bridge must re-render.
      await Effect.runPromise(SubscriptionRef.update(ref, () => [{ id: "x", name: "live-one", createdAt: "t" }]))
      await new Promise((r) => setTimeout(r, 50)) // let the forked stream + React flush
      expect(lastFrame()).toContain("live-one")
      expect(lastFrame()).toContain("Projects (1)")
    } finally {
      await runtime.dispose()
    }
  })
})
