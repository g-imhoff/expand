import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Effect, ManagedRuntime, Layer, Stream, SubscriptionRef } from "effect"
import { BunServices } from "@effect/platform-bun"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ProjectStore } from "@yodea/client-core"
import { ProjectStoreLayer } from "@yodea/client-core/project-store"
import { makeBunAdapter } from "@yodea/client-core/adapters/bun"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yodea-bun-spawn-"))
  process.env.YODEA_HOME = dir
})
afterEach(() => {
  delete process.env.YODEA_HOME
  rmSync(dir, { recursive: true, force: true })
})

// The Bun adapter must be able to spawn the REAL backend even when Bun.main is
// NOT the CLI entry (e.g. the Ink TUI). We give it an explicit backendCommand
// pointing at the source CLI entry — and crucially we do NOT touch Bun.main, so
// the bare `bunAdapter` (which derives the command from Bun.main) would here
// launch the vitest worker as a "second TUI" and never boot a backend. This
// proves the explicit-command spawn genuinely boots the backend (I-2 find-or-spawn).
describe("Bun adapter (explicit backendCommand)", () => {
  it("spawns the real backend + reflects a create in the live ref", async () => {
    const adapter = makeBunAdapter({
      backendCommand: [process.execPath, join(process.cwd(), "apps/cli/cli/main.ts"), "server"]
    })
    const rt = ManagedRuntime.make(ProjectStoreLayer(adapter).pipe(Layer.provide(BunServices.layer)))
    try {
      const store = await rt.runPromise(ProjectStore)
      // Watch the ref BEFORE the create: the ref is eventually-consistent and only
      // reflects "spawned" once the live Events fold receives the server-pushed
      // ProjectCreated over the transport. A bounded timeout keeps the test honest —
      // if no backend was spawned, the create RPC dies and this never resolves.
      const seen = rt.runPromise(
        SubscriptionRef.changes(store.projects).pipe(
          Stream.filter((ps) => ps.some((p) => p.name === "spawned")),
          Stream.take(1),
          Stream.runDrain,
          Effect.timeout("5 seconds")
        )
      )
      const created = await rt.runPromise(store.createProject("spawned"))
      expect(created.name).toBe("spawned")
      await seen // resolves only once the live Events fold updated the ref

      const list = await rt.runPromise(SubscriptionRef.get(store.projects))
      expect(list.map((p) => p.name)).toContain("spawned")
    } finally {
      await rt.dispose()
    }
  })
})
