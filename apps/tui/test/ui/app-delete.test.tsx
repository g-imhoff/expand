import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import React from "react"
import { Effect } from "effect"
import { App } from "@expand/tui/components/app"
import { fakeProject, makeRuntimeHarnessScoped, renderWithRuntimeScoped } from "./_runtime-harness"

// See app-input-routing.test.tsx for the full rationale. ink wires its input hook
// across two effects; between them a written key is read off stdin but routed to
// nobody and lost. Under load that window outlasts any fixed delay — the flake.
// So poll for observable outcomes, and warm the pipeline up with Tab (a focus
// toggle that never types text) before the first real keypress.
const ensureInputLive = (view: Effect.Success<ReturnType<typeof renderWithRuntimeScoped>>, atRest: string) =>
  Effect.gen(function* () {
    yield* view.awaitFrame(atRest) // seeded + reconciled before warm-up
    yield* view.writeAndAwaitFrame("\t", "return create")
    yield* view.writeAndAwaitFrame("\t", "r rename")
    yield* view.awaitFrame(atRest) // round-trip preserved selection
  })

describe("App delete keybinding", () => {
  it.effect("pressing 'x' opens the confirm prompt and 'y' deletes the project", () =>
    Effect.scoped(Effect.gen(function* () {
      const harness = yield* makeRuntimeHarnessScoped({
        snapshot: { projects: [fakeProject(1, "alpha")], seq: 0 }
      })
      const view = yield* renderWithRuntimeScoped(<App />, harness)
      yield* view.mounted
      yield* ensureInputLive(view, "▸ alpha")
      yield* view.writeAndAwaitFrame("x", "delete") // confirm prompt open
      expect(view.lastFrame()).toContain("alpha")
      view.stdin.write("y")
      yield* harness.observed.call("delete")
      expect(harness.authoritative.get().projects).toHaveLength(0)
    })))

  it.effect("pressing 'x' then Escape cancels without deleting", () =>
    Effect.scoped(Effect.gen(function* () {
      const harness = yield* makeRuntimeHarnessScoped({
        snapshot: { projects: [fakeProject(1, "alpha")], seq: 0 }
      })
      const view = yield* renderWithRuntimeScoped(<App />, harness)
      yield* view.mounted
      yield* ensureInputLive(view, "▸ alpha")
      yield* view.writeAndAwaitFrame("x", "delete") // confirm prompt open
      // Cancel completing is observable as the confirm prompt closing — the list
      // hint returns. Once back at rest, assert the project is still there.
      yield* view.writeAndAwaitFrame("\x1b", "r rename") // escape cancels
      const remaining = harness.authoritative.get().projects
      expect(remaining).toHaveLength(1)
    })))
})
