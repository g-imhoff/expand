import { describe, expect, it, vi } from "vitest"
import React from "react"
import { render } from "ink-testing-library"
import { Effect, Layer, ManagedRuntime, Stream, SubscriptionRef } from "effect"
import { ProjectStore, type ConnectionStatus } from "@yodea/client-core"
import { ProjectNameConflict } from "@yodea/contracts/rpc"
import { ProjectId, ProjectName, Tag } from "@yodea/contracts/project"
import { RuntimeContext } from "@yodea/tui/runtime"
import { App } from "@yodea/tui/components/app"

// See app-input-routing.test.tsx for the full rationale. ink wires `useInput`
// across two effects; between them a written key is read off stdin but routed to
// nobody and lost — and that window outlasts any fixed delay under load, which
// is the flake. So poll for observable outcomes, and warm the pipeline up with
// Tab (a focus toggle that never types text) before the first real keypress.
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
  await waitForFrame(lastFrame, atRest) // round-trip preserved at-rest state
}

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

const fakeLayer = (ref: SubscriptionRef.SubscriptionRef<ReadonlyArray<any>>) =>
  Layer.succeed(ProjectStore, {
    projects: ref,
    status: Effect.runSync(SubscriptionRef.make<ConnectionStatus>("connected")),
    events: Stream.empty,
    snapshot: Effect.map(SubscriptionRef.get(ref), (projects) => ({ projects, seq: 0 })),
    createProject: (name: ProjectName) =>
      SubscriptionRef.update(ref, (c) => [...c, { id: uid(1), name, directory: null, description: null, tags: [], archived: false, createdAt: "t", updatedAt: "t" }]).pipe(
        Effect.as({ id: uid(1), name, directory: null, description: null, tags: [], archived: false, createdAt: "t", updatedAt: "t" } as any)
      ),
    renameProject: (_id: ProjectId, name: ProjectName) => Effect.fail(new ProjectNameConflict({ name })),
    changeDirectory: () => Effect.die("unused"),
    archiveProject: () => Effect.die("unused"),
    restoreProject: () => Effect.die("unused"),
    setMetadata: () => Effect.die("unused"),
    deleteProject: () => Effect.die("unused")
  })

describe("App mutation error line", () => {
  it("renders a failed rename and clears it on the next successful mutation", async () => {
    const ref = await Effect.runPromise(SubscriptionRef.make<ReadonlyArray<any>>([
      { id: "p1", name: "alpha", directory: null, description: null, tags: [], archived: false, createdAt: "t", updatedAt: "t" }
    ]))
    const runtime = ManagedRuntime.make(fakeLayer(ref))
    try {
      const { stdin, lastFrame } = render(
        <RuntimeContext.Provider value={runtime as any}><App /></RuntimeContext.Provider>
      )
      await ensureInputLive(stdin, lastFrame, "▸ alpha")
      stdin.write("r")
      await waitForFrame(lastFrame, "rename ▸") // rename overlay open
      stdin.write("\r")
      await waitForFrame(lastFrame, 'name conflict: "alpha" already exists')
      stdin.write("n") // focus create before typing
      await waitForFrame(lastFrame, "return create") // create focused (re-rendered)
      stdin.write("zen")
      await waitForFrame(lastFrame, "zen") // draft typed
      stdin.write("\r")
      // The successful create clears the error; wait for the new project to land
      // (positive), then assert the conflict line is gone.
      await waitForFrame(lastFrame, "• zen")
      expect(lastFrame()).not.toContain("name conflict")
      expect(lastFrame()).toContain("zen")
    } finally {
      await runtime.dispose()
    }
  })

  it("shows 'invalid input' when an invalid project name is submitted", async () => {
    const ref = await Effect.runPromise(SubscriptionRef.make<ReadonlyArray<any>>([]))
    const runtime = ManagedRuntime.make(fakeLayer(ref))
    try {
      const { stdin, lastFrame } = render(
        <RuntimeContext.Provider value={runtime as any}><App /></RuntimeContext.Provider>
      )
      await ensureInputLive(stdin, lastFrame, "no projects yet")
      stdin.write("n") // focus create before typing
      await waitForFrame(lastFrame, "return create") // create focused (re-rendered)
      // "INVALID NAME!!!" contains uppercase + spaces — fails ProjectName regex
      stdin.write("INVALID NAME!!!")
      await waitForFrame(lastFrame, "INVALID NAME!!!") // draft typed
      stdin.write("\r")
      await waitForFrame(lastFrame, "invalid input")
      expect(lastFrame()).toContain("Expected a string matching")
    } finally {
      await runtime.dispose()
    }
  })
})
