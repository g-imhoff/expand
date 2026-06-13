import { describe, expect, it, vi } from "vitest"
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
// Poll for an observable outcome instead of sleeping a fixed time: ink attaches
// its stdin listener and flushes renders on async ticks whose timing varies under
// load, so fixed delays are flaky. vi.waitFor re-runs the assertion until it
// settles.
const WAIT = { timeout: 2000, interval: 10 } as const
const waitForFrame = (lastFrame: () => string | undefined, text: string) =>
  vi.waitFor(() => expect(lastFrame()).toContain(text), WAIT)
// ink's input hook wires input in TWO separate effects: one enables raw mode
// (which attaches stdin's "readable" listener) and a LATER one subscribes the
// key handler to ink's internal "input" emitter. Between them there is a window
// where a key is read off stdin but routed to nobody — and a dropped key is
// gone, because ink-testing-library emits "readable" exactly once per write.
// Under load that window stays open well past any fixed delay, which is the
// flake. The only reliable proof the WHOLE pipeline is live is a key actually
// routing. So warm it up with Tab, which toggles focus list↔create and NEVER
// types text. We nudge with Tab only while the frame still shows the source
// context, so it converges (even with a stale-closure double-write: two Tabs
// from a list-focused state both resolve to FocusCreate, never past it) and
// leaves the App back in its clean at-rest list focus.
type Stdin = { write: (s: string) => void }
const has = (lastFrame: () => string | undefined, text: string) =>
  (lastFrame() ?? "").includes(text)
// `atRest` is a frame substring that proves the App finished loading its SEEDED
// projects and reconciled (e.g. the selection marker "▸ alpha"). The projects
// arrive on a background fiber, so the very first render is always empty — the
// caller must hand us the post-load signal so we don't warm up prematurely.
const ensureInputLive = async (
  stdin: Stdin, lastFrame: () => string | undefined, atRest: string
) => {
  // Wait for the seeded, reconciled state. The warm-up below writes Tab, which
  // calls setUi({...ui, focus}); if it ran before reconcile set the selection it
  // would spread a selectedId=null state and clobber the selection.
  await waitForFrame(lastFrame, atRest)
  await vi.waitFor(() => {
    if (has(lastFrame, "r rename")) stdin.write("\t")    // list → nudge to create
    expect(lastFrame()).toContain("return create")       // create hint = routed
  }, WAIT)
  await vi.waitFor(() => {
    if (has(lastFrame, "return create")) stdin.write("\t") // create → nudge to list
    expect(lastFrame()).toContain("r rename")             // back at rest
  }, WAIT)
  // Confirm the round-trip preserved the at-rest seeded state.
  await waitForFrame(lastFrame, atRest)
}

describe("App input routing (C1 regression, end-to-end)", () => {
  it("typing a command-lettered name into the create field mutates nothing", async () => {
    const ref = await Effect.runPromise(SubscriptionRef.make<ReadonlyArray<any>>([seed(1, "alpha")]))
    const runtime = ManagedRuntime.make(fakeLayer(ref))
    try {
      const { stdin, lastFrame } = render(
        <RuntimeContext.Provider value={runtime as any}><App /></RuntimeContext.Provider>
      )
      await ensureInputLive(stdin, lastFrame, "▸ alpha")
      stdin.write("n")          // focus create (list is focused by default)
      await waitForFrame(lastFrame, "return create") // create field focused (re-rendered)
      stdin.write("data")       // contains d (dir), a (archive!), t, a
      await waitForFrame(lastFrame, "data")          // draft visible — step processed
      expect(lastFrame()).not.toContain("[archived]")  // 'a' did NOT archive
      expect(lastFrame()).not.toContain("directory ▸") // 'd' did NOT open dir overlay
      stdin.write("\r")         // submit
      await vi.waitFor(async () => {
        const projects = await Effect.runPromise(SubscriptionRef.get(ref))
        expect(projects).toHaveLength(2)               // project created
      }, WAIT)
      expect(lastFrame()).toContain("data")
      const projects = await Effect.runPromise(SubscriptionRef.get(ref))
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
      await ensureInputLive(stdin, lastFrame, "▸ alpha")
      stdin.write("n")
      await waitForFrame(lastFrame, "return create") // create field focused (re-rendered)
      stdin.write("xy")
      await waitForFrame(lastFrame, "xy")            // both chars typed
      stdin.write("\x7f") // backspace (DEL)
      // After the edit settles to "x" (draft no longer shows "xy"), the negative
      // — no delete overlay — can be asserted at a settled state.
      await vi.waitFor(() => {
        expect(lastFrame()).toContain("new project ▸ x") // draft edited to "x"
        expect(lastFrame()).not.toContain("xy")
      }, WAIT)
      expect(lastFrame()).not.toContain("delete “")
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
      await ensureInputLive(stdin, lastFrame, "▸ alpha")
      stdin.write("j") // select beta
      await waitForFrame(lastFrame, "▸ beta") // selection moved to beta
      stdin.write("a") // archive SELECTED (beta), not projects[0]
      await vi.waitFor(async () => {
        const ps = await Effect.runPromise(SubscriptionRef.get(ref))
        expect(ps.find((p: any) => p.name === "beta")?.archived).toBe(true)
      }, WAIT)
      const projects = await Effect.runPromise(SubscriptionRef.get(ref))
      expect(projects.find((p: any) => p.name === "alpha")?.archived).toBe(false)
      await waitForFrame(lastFrame, "[archived]")
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
      await ensureInputLive(stdin, lastFrame, "▸ alpha")
      stdin.write("m")
      await waitForFrame(lastFrame, "description ▸") // metadata overlay open
      stdin.write("hello")
      await waitForFrame(lastFrame, "hello")         // description draft visible
      stdin.write("\t") // switch to tags
      // tags field becomes focused; type into it once the switch settled.
      await waitForFrame(lastFrame, "tags (a, b) ▸")
      stdin.write("api, db")
      await waitForFrame(lastFrame, "api, db")       // tags draft visible
      stdin.write("\r") // submit both
      await vi.waitFor(async () => {
        const ps = await Effect.runPromise(SubscriptionRef.get(ref))
        expect(ps[0]?.description).toBe("hello")
        expect(ps[0]?.tags).toEqual(["api", "db"])
      }, WAIT)
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
      await ensureInputLive(stdin, lastFrame, "▸ alpha")
      stdin.write("m")
      await waitForFrame(lastFrame, "description ▸") // metadata overlay open
      stdin.write("oops")
      await waitForFrame(lastFrame, "oops")          // draft typed
      stdin.write("\x1b") // escape
      // The overlay closing is observable as the create field returning; once the
      // create field is back, the metadata overlay is provably gone.
      await waitForFrame(lastFrame, "new project ▸")
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
      await ensureInputLive(stdin, lastFrame, "▸ alpha")
      expect(lastFrame()).toContain("r rename")   // list context
      stdin.write("x")
      // Wait for the confirm context to be active; once "y confirm" shows, the
      // list hint must be gone, so the negative is asserted at a settled state.
      await waitForFrame(lastFrame, "y confirm")  // confirm context
      expect(lastFrame()).not.toContain("r rename")
    } finally {
      await runtime.dispose()
    }
  })
})
