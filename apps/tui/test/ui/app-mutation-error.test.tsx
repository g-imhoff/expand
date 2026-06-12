import { describe, expect, it } from "vitest"
import React from "react"
import { render } from "ink-testing-library"
import { Effect, Layer, ManagedRuntime, Stream, SubscriptionRef } from "effect"
import { ProjectStore, type ConnectionStatus } from "@yodea/client-core"
import { ProjectNameConflict } from "@yodea/contracts/rpc"
import { ProjectId, ProjectName, Tag } from "@yodea/contracts/project"
import { RuntimeContext } from "@yodea/tui/runtime"
import { App } from "@yodea/tui/components/app"

// ink 7 + ink-testing-library 4: useInput attaches its listener after the
// initial commit, so writes must happen after a macrotask flush.
const flush = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

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
      await flush(50)
      stdin.write("r")
      await flush(80)
      expect(lastFrame()).toContain("rename")
      stdin.write("\r")
      await flush(80)
      expect(lastFrame()).toContain('name conflict: "alpha" already exists')
      stdin.write("zen")
      await flush(80)
      stdin.write("\r")
      await flush(80)
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
      await flush(50)
      // "INVALID NAME!!!" contains uppercase + spaces — fails ProjectName regex
      stdin.write("INVALID NAME!!!")
      await flush(80)
      stdin.write("\r")
      await flush(80)
      expect(lastFrame()).toContain("invalid input")
      expect(lastFrame()).toContain("Expected a string matching")
    } finally {
      await runtime.dispose()
    }
  })
})
