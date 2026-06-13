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
      SubscriptionRef.update(ref, (c) => [...c, { id: uid(c.length + 1), name, directory: null, description: null, tags: [] as ReadonlyArray<Tag>, archived: false, createdAt: "t", updatedAt: "t" }]).pipe(Effect.as({ id: uid(1), name, directory: null, description: null, tags: [] as ReadonlyArray<Tag>, archived: false, createdAt: "t", updatedAt: "t" } as any)),
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

const seed = (n: number, name: string) => ({
  id: uid(n), name: name as any, directory: null, description: null,
  tags: [], archived: false, createdAt: "t", updatedAt: "t"
})
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms))

describe("App input routing (C1 regression, end-to-end)", () => {
  it("typing a command-lettered name into the create field mutates nothing", async () => {
    const ref = await Effect.runPromise(SubscriptionRef.make<ReadonlyArray<any>>([seed(1, "alpha")]))
    const runtime = ManagedRuntime.make(fakeLayer(ref))
    try {
      const { stdin, lastFrame } = render(
        <RuntimeContext.Provider value={runtime as any}><App /></RuntimeContext.Provider>
      )
      await tick()
      stdin.write("n")          // focus create (list is focused by default)
      await tick()
      stdin.write("data")       // contains d (dir), a (archive!), t, a
      await tick()
      expect(lastFrame()).toContain("data")            // draft visible
      expect(lastFrame()).not.toContain("[archived]")  // 'a' did NOT archive
      expect(lastFrame()).not.toContain("directory ▸") // 'd' did NOT open dir overlay
      stdin.write("\r")         // submit
      await tick()
      expect(lastFrame()).toContain("data")            // project created
      const projects = await Effect.runPromise(SubscriptionRef.get(ref))
      expect(projects).toHaveLength(2)
      expect(projects.every((p: any) => p.archived === false)).toBe(true)
    } finally {
      await runtime.dispose()
    }
  })

  it("backspace while typing never opens the delete confirmation", async () => {
    const ref = await Effect.runPromise(SubscriptionRef.make<ReadonlyArray<any>>([seed(1, "alpha")]))
    const runtime = ManagedRuntime.make(fakeLayer(ref))
    try {
      const { stdin, lastFrame } = render(
        <RuntimeContext.Provider value={runtime as any}><App /></RuntimeContext.Provider>
      )
      await tick()
      stdin.write("n")
      await tick()
      stdin.write("xy")
      await tick()
      stdin.write("\x7f") // backspace (DEL)
      await tick()
      expect(lastFrame()).not.toContain("delete “")
      expect(lastFrame()).toContain("x") // draft edited to "x"
    } finally {
      await runtime.dispose()
    }
  })

  it("j/k navigate a real selection and commands act on it", async () => {
    const ref = await Effect.runPromise(SubscriptionRef.make<ReadonlyArray<any>>([seed(1, "alpha"), seed(2, "beta")]))
    const runtime = ManagedRuntime.make(fakeLayer(ref))
    try {
      const { stdin, lastFrame } = render(
        <RuntimeContext.Provider value={runtime as any}><App /></RuntimeContext.Provider>
      )
      await tick()
      stdin.write("j") // select beta
      await tick()
      stdin.write("a") // archive SELECTED (beta), not projects[0]
      await tick()
      const projects = await Effect.runPromise(SubscriptionRef.get(ref))
      expect(projects.find((p: any) => p.name === "beta")?.archived).toBe(true)
      expect(projects.find((p: any) => p.name === "alpha")?.archived).toBe(false)
      expect(lastFrame()).toContain("[archived]")
    } finally {
      await runtime.dispose()
    }
  })

  it("metadata overlay: description + tags with tab switch (C8 parity)", async () => {
    const ref = await Effect.runPromise(SubscriptionRef.make<ReadonlyArray<any>>([seed(1, "alpha")]))
    const runtime = ManagedRuntime.make(fakeLayer(ref))
    try {
      const { stdin, lastFrame } = render(
        <RuntimeContext.Provider value={runtime as any}><App /></RuntimeContext.Provider>
      )
      await tick()
      stdin.write("m")
      await tick()
      expect(lastFrame()).toContain("description ▸")
      stdin.write("hello")
      await tick()
      stdin.write("\t") // switch to tags
      await tick()
      stdin.write("api, db")
      await tick()
      stdin.write("\r") // submit both
      await tick()
      const projects = await Effect.runPromise(SubscriptionRef.get(ref))
      expect(projects[0]?.description).toBe("hello")
      expect(projects[0]?.tags).toEqual(["api", "db"])
    } finally {
      await runtime.dispose()
    }
  })

  it("escape cancels metadata with zero mutations (C8: cancel exists now)", async () => {
    const ref = await Effect.runPromise(SubscriptionRef.make<ReadonlyArray<any>>([seed(1, "alpha")]))
    const runtime = ManagedRuntime.make(fakeLayer(ref))
    try {
      const { stdin, lastFrame } = render(
        <RuntimeContext.Provider value={runtime as any}><App /></RuntimeContext.Provider>
      )
      await tick()
      stdin.write("m")
      await tick()
      stdin.write("oops")
      await tick()
      stdin.write("\x1b") // escape
      await tick()
      expect(lastFrame()).not.toContain("description ▸")
      const projects = await Effect.runPromise(SubscriptionRef.get(ref))
      expect(projects[0]?.description).toBeNull()
    } finally {
      await runtime.dispose()
    }
  })

  it("hint bar reflects the active context", async () => {
    const ref = await Effect.runPromise(SubscriptionRef.make<ReadonlyArray<any>>([seed(1, "alpha")]))
    const runtime = ManagedRuntime.make(fakeLayer(ref))
    try {
      const { stdin, lastFrame } = render(
        <RuntimeContext.Provider value={runtime as any}><App /></RuntimeContext.Provider>
      )
      await tick()
      expect(lastFrame()).toContain("r rename")   // list context
      stdin.write("x")
      await tick()
      expect(lastFrame()).toContain("y confirm")  // confirm context
      expect(lastFrame()).not.toContain("r rename")
    } finally {
      await runtime.dispose()
    }
  })
})
