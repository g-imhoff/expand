import { describe, expect, it, vi } from "vitest"
import React from "react"
import { render } from "ink-testing-library"
import { Effect, Layer, ManagedRuntime, Stream, SubscriptionRef } from "effect"
import { ProjectStore, type ConnectionStatus } from "@expand/client-ts"
import { RuntimeContext } from "@expand/tui/runtime"
import { App } from "@expand/tui/components/app"

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` as string

const fakeLayer = (ref: SubscriptionRef.SubscriptionRef<ReadonlyArray<any>>) =>
  Layer.succeed(ProjectStore, {
    projects: ref,
    status: Effect.runSync(SubscriptionRef.make<ConnectionStatus>("connected")),
    events: Stream.empty,
    snapshot: Effect.map(SubscriptionRef.get(ref), (projects) => ({ projects, seq: 0 })),
    createProject: (name: string) =>
      SubscriptionRef.update(ref, (c) => [...c, { id: uid(1), name, directory: null, description: null, tags: [] as ReadonlyArray<string>, archived: false, createdAt: "t", updatedAt: "t" }]).pipe(Effect.as({ id: uid(1), name, directory: null, description: null, tags: [] as ReadonlyArray<string>, archived: false, createdAt: "t", updatedAt: "t" } as any)),
    renameProject: (id: string, name: string) =>
      SubscriptionRef.updateAndGet(ref, (cur) => cur.map((p: any) => (p.id === id ? { ...p, name } : p))).pipe(
        Effect.map((cur) => cur.find((p: any) => p.id === id) as any)
      ),
    changeDirectory: (id: string, directory: string) =>
      SubscriptionRef.updateAndGet(ref, (cur) => cur.map((p: any) => (p.id === id ? { ...p, directory } : p))).pipe(
        Effect.map((cur) => cur.find((p: any) => p.id === id) as any)
      ),
    archiveProject: (id: string) =>
      SubscriptionRef.modify(ref, (c) => {
        const next = c.map((p: any) => p.id === id ? { ...p, archived: true } : p)
        return [next.find((p: any) => p.id === id) as any, next] as const
      }),
    restoreProject: (id: string) =>
      SubscriptionRef.modify(ref, (c) => {
        const next = c.map((p: any) => p.id === id ? { ...p, archived: false } : p)
        return [next.find((p: any) => p.id === id) as any, next] as const
      }),
    setMetadata: (id: string, patch: { description?: string | null; tags?: ReadonlyArray<string> }) =>
      SubscriptionRef.modify(ref, (c) => {
        const next = c.map((p: any) => p.id === id ? { ...p, ...patch } : p)
        return [next.find((p: any) => p.id === id) as any, next] as const
      }),
    deleteProject: (id: string) =>
      SubscriptionRef.update(ref, (c) => c.filter((p: any) => p.id !== id)).pipe(
        Effect.as({ id, deleted: true } as const)
      )
  })

// See app-input-routing.test.tsx for the full rationale. ink wires its input hook
// across two effects; between them a written key is read off stdin but routed to
// nobody and lost. Under load that window outlasts any fixed delay — the flake.
// So poll for observable outcomes, and warm the pipeline up with Tab (a focus
// toggle that never types text) before the first real keypress.
const WAIT = { timeout: 2000, interval: 10 } as const
const waitForFrame = (lastFrame: () => string | undefined, text: string) =>
  vi.waitFor(() => expect(lastFrame()).toContain(text), WAIT)
const has = (lastFrame: () => string | undefined, text: string) =>
  (lastFrame() ?? "").includes(text)
const ensureInputLive = async (
  stdin: { write: (s: string) => void }, lastFrame: () => string | undefined, atRest: string
) => {
  await waitForFrame(lastFrame, atRest) // seeded + reconciled before warm-up
  await vi.waitFor(() => {
    if (has(lastFrame, "r rename")) stdin.write("\t")
    expect(lastFrame()).toContain("return create")
  }, WAIT)
  await vi.waitFor(() => {
    if (has(lastFrame, "return create")) stdin.write("\t")
    expect(lastFrame()).toContain("r rename")
  }, WAIT)
  await waitForFrame(lastFrame, atRest) // round-trip preserved selection
}

describe("App delete keybinding", () => {
  it("pressing 'x' opens the confirm prompt and 'y' deletes the project", async () => {
    const ref = await Effect.runPromise(SubscriptionRef.make<ReadonlyArray<any>>([
      { id: uid(1), name: "alpha" as string, directory: null, description: null, tags: [], archived: false, createdAt: "t", updatedAt: "t" }
    ]))
    const runtime = ManagedRuntime.make(fakeLayer(ref))
    try {
      const { stdin, lastFrame } = render(
        <RuntimeContext.Provider value={runtime as any}><App /></RuntimeContext.Provider>
      )
      await ensureInputLive(stdin, lastFrame, "▸ alpha")
      stdin.write("x")
      await waitForFrame(lastFrame, "delete") // confirm prompt open
      expect(lastFrame()).toContain("alpha")
      stdin.write("y")
      await vi.waitFor(async () => {
        const remaining = await Effect.runPromise(SubscriptionRef.get(ref))
        expect(remaining).toHaveLength(0)
      }, WAIT)
    } finally {
      await runtime.dispose()
    }
  })

  it("pressing 'x' then Escape cancels without deleting", async () => {
    const ref = await Effect.runPromise(SubscriptionRef.make<ReadonlyArray<any>>([
      { id: uid(1), name: "alpha" as string, directory: null, description: null, tags: [], archived: false, createdAt: "t", updatedAt: "t" }
    ]))
    const runtime = ManagedRuntime.make(fakeLayer(ref))
    try {
      const { stdin, lastFrame } = render(
        <RuntimeContext.Provider value={runtime as any}><App /></RuntimeContext.Provider>
      )
      await ensureInputLive(stdin, lastFrame, "▸ alpha")
      stdin.write("x")
      await waitForFrame(lastFrame, "delete") // confirm prompt open
      stdin.write("\x1b") // escape cancels
      // Cancel completing is observable as the confirm prompt closing — the list
      // hint returns. Once back at rest, assert the project is still there.
      await waitForFrame(lastFrame, "r rename")
      const remaining = await Effect.runPromise(SubscriptionRef.get(ref))
      expect(remaining).toHaveLength(1)
    } finally {
      await runtime.dispose()
    }
  })
})
