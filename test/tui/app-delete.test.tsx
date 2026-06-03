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
    createProject: (name: string) =>
      SubscriptionRef.update(ref, (c) => [...c, { id: `id-${name}`, name, directory: null, description: null, tags: [], archived: false, createdAt: "t", updatedAt: "t" }]).pipe(Effect.as({ id: `id-${name}`, name, directory: null, description: null, tags: [], archived: false, createdAt: "t", updatedAt: "t" })),
    renameProject: (id: string, name: string) =>
      SubscriptionRef.updateAndGet(ref, (cur) => cur.map((p: any) => (p.id === id ? { ...p, name } : p))).pipe(
        Effect.map((cur) => cur.find((p: any) => p.id === id))
      ),
    changeDirectory: (id: string, directory: string) =>
      SubscriptionRef.updateAndGet(ref, (cur) => cur.map((p: any) => (p.id === id ? { ...p, directory } : p))).pipe(
        Effect.map((cur) => cur.find((p: any) => p.id === id))
      ),
    archiveProject: (id: string) =>
      SubscriptionRef.modify(ref, (c) => {
        const next = c.map((p: any) => p.id === id ? { ...p, archived: true } : p)
        return [next.find((p: any) => p.id === id), next] as const
      }),
    restoreProject: (id: string) =>
      SubscriptionRef.modify(ref, (c) => {
        const next = c.map((p: any) => p.id === id ? { ...p, archived: false } : p)
        return [next.find((p: any) => p.id === id), next] as const
      }),
    setMetadata: (id: string, patch: { description?: string | null; tags?: ReadonlyArray<string> }) =>
      SubscriptionRef.modify(ref, (c) => {
        const next = c.map((p: any) => p.id === id ? { ...p, ...patch } : p)
        return [next.find((p: any) => p.id === id), next] as const
      }),
    deleteProject: (id: string) =>
      SubscriptionRef.update(ref, (c) => c.filter((p: any) => p.id !== id)).pipe(
        Effect.as({ id, deleted: true } as const)
      )
  })

describe("App delete keybinding", () => {
  it("pressing 'x' opens the confirm prompt and 'y' deletes the project", async () => {
    const ref = await Effect.runPromise(SubscriptionRef.make<ReadonlyArray<any>>([
      { id: "p1", name: "alpha", directory: null, description: null, tags: [], archived: false, createdAt: "t", updatedAt: "t" }
    ]))
    const runtime = ManagedRuntime.make(fakeLayer(ref))
    try {
      const { stdin, lastFrame } = render(
        <RuntimeContext.Provider value={runtime as any}><App /></RuntimeContext.Provider>
      )
      await new Promise((r) => setTimeout(r, 50))
      stdin.write("x")
      await new Promise((r) => setTimeout(r, 80))
      // ConfirmDelete is now mounted for the selected project.
      expect(lastFrame()).toContain("delete")
      expect(lastFrame()).toContain("alpha")
      stdin.write("y")
      await new Promise((r) => setTimeout(r, 80))
      // Delete removed the project from the store-backed list.
      const remaining = await Effect.runPromise(SubscriptionRef.get(ref))
      expect(remaining).toHaveLength(0)
    } finally {
      await runtime.dispose()
    }
  })

  it("pressing 'x' then Escape cancels without deleting", async () => {
    const ref = await Effect.runPromise(SubscriptionRef.make<ReadonlyArray<any>>([
      { id: "p1", name: "alpha", directory: null, description: null, tags: [], archived: false, createdAt: "t", updatedAt: "t" }
    ]))
    const runtime = ManagedRuntime.make(fakeLayer(ref))
    try {
      const { stdin, lastFrame } = render(
        <RuntimeContext.Provider value={runtime as any}><App /></RuntimeContext.Provider>
      )
      await new Promise((r) => setTimeout(r, 50))
      stdin.write("x")
      await new Promise((r) => setTimeout(r, 80))
      expect(lastFrame()).toContain("delete")
      stdin.write("\x1b") // Escape
      await new Promise((r) => setTimeout(r, 80))
      const remaining = await Effect.runPromise(SubscriptionRef.get(ref))
      expect(remaining).toHaveLength(1)
    } finally {
      await runtime.dispose()
    }
  })
})
