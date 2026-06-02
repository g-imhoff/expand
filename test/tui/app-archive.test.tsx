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

describe("App archive keybinding", () => {
  it("pressing 'a' archives the selected project", async () => {
    const ref = await Effect.runPromise(SubscriptionRef.make<ReadonlyArray<any>>([
      { id: "p1", name: "alpha", directory: null, description: null, tags: [], archived: false, createdAt: "t", updatedAt: "t" }
    ]))
    const runtime = ManagedRuntime.make(fakeLayer(ref))
    try {
      const { stdin, lastFrame } = render(
        <RuntimeContext.Provider value={runtime as any}><App /></RuntimeContext.Provider>
      )
      await new Promise((r) => setTimeout(r, 50))
      stdin.write("a")
      await new Promise((r) => setTimeout(r, 80))
      expect(lastFrame()).toContain("[archived]")
    } finally {
      await runtime.dispose()
    }
  })

  it("shows a project that is ALREADY archived at startup and restores it with 'a'", async () => {
    // Regression: the store snapshot (project-store.ts) must seed with
    // includeArchived:true so a project archived in a prior session is present from
    // startup — selectable (selected = projects[0]) and restorable with 'a'. Without
    // it the snapshot excluded archived, the project vanished, and restore was
    // unreachable from the TUI. Here the ref starts with an archived project (mirroring
    // the fixed snapshot); pressing 'a' must flip it back to live (marker gone).
    const ref = await Effect.runPromise(SubscriptionRef.make<ReadonlyArray<any>>([
      { id: "p1", name: "alpha", directory: null, description: null, tags: [], archived: true, createdAt: "t", updatedAt: "t" }
    ]))
    const runtime = ManagedRuntime.make(fakeLayer(ref))
    try {
      const { stdin, lastFrame } = render(
        <RuntimeContext.Provider value={runtime as any}><App /></RuntimeContext.Provider>
      )
      await new Promise((r) => setTimeout(r, 50))
      expect(lastFrame()).toContain("[archived]")
      stdin.write("a")
      await new Promise((r) => setTimeout(r, 80))
      expect(lastFrame()).not.toContain("[archived]")
    } finally {
      await runtime.dispose()
    }
  })
})
