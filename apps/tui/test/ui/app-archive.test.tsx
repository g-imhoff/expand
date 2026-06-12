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
    createProject: (name: ProjectName) =>
      SubscriptionRef.update(ref, (c) => [...c, { id: uid(1), name, directory: null, description: null, tags: [] as ReadonlyArray<Tag>, archived: false, createdAt: "t", updatedAt: "t" }]).pipe(Effect.as({ id: uid(1), name, directory: null, description: null, tags: [] as ReadonlyArray<Tag>, archived: false, createdAt: "t", updatedAt: "t" } as any)),
    renameProject: (id: ProjectId, name: ProjectName) =>
      SubscriptionRef.updateAndGet(ref, (cur) => cur.map((p: any) => (p.id === id ? { ...p, name } : p))).pipe(
        Effect.map((cur) => cur.find((p: any) => p.id === id) as any)
      ),
    changeDirectory: (id: ProjectId, directory: string) =>
      SubscriptionRef.updateAndGet(ref, (cur) => cur.map((p: any) => (p.id === id ? { ...p, directory } : p))).pipe(
        Effect.map((cur) => cur.find((p: any) => p.id === id) as any)
      ),
    archiveProject: (id: ProjectId) =>
      SubscriptionRef.modify(ref, (c) => {
        const next = c.map((p: any) => p.id === id ? { ...p, archived: true } : p)
        return [next.find((p: any) => p.id === id) as any, next] as const
      }),
    restoreProject: (id: ProjectId) =>
      SubscriptionRef.modify(ref, (c) => {
        const next = c.map((p: any) => p.id === id ? { ...p, archived: false } : p)
        return [next.find((p: any) => p.id === id) as any, next] as const
      }),
    setMetadata: (id: ProjectId, patch: { description?: string | null; tags?: ReadonlyArray<Tag> }) =>
      SubscriptionRef.modify(ref, (c) => {
        const next = c.map((p: any) => p.id === id ? { ...p, ...patch } : p)
        return [next.find((p: any) => p.id === id) as any, next] as const
      }),
    deleteProject: (id: ProjectId) =>
      SubscriptionRef.update(ref, (c) => c.filter((p: any) => p.id !== id)).pipe(
        Effect.as({ id, deleted: true } as const)
      )
  })

describe("App archive keybinding", () => {
  it("pressing 'a' archives the selected project", async () => {
    const ref = await Effect.runPromise(SubscriptionRef.make<ReadonlyArray<any>>([
      { id: uid(1), name: "alpha" as ProjectName, directory: null, description: null, tags: [], archived: false, createdAt: "t", updatedAt: "t" }
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
    const ref = await Effect.runPromise(SubscriptionRef.make<ReadonlyArray<any>>([
      { id: uid(1), name: "alpha" as ProjectName, directory: null, description: null, tags: [], archived: true, createdAt: "t", updatedAt: "t" }
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
