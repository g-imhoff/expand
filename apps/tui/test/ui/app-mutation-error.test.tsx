import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import React from "react"
import { Effect } from "effect"
import { ProjectNameConflict } from "@expand/contracts/rpc"
import { App } from "@expand/tui/components/app"
import { fakeProject, makeRuntimeHarnessScoped, renderWithRuntimeScoped } from "./_runtime-harness"

// See app-input-routing.test.tsx for the full rationale. ink wires its input hook
// across two effects; between them a written key is read off stdin but routed to
// nobody and lost — and that window outlasts any fixed delay under load, which
// is the flake. So poll for observable outcomes, and warm the pipeline up with
// Tab (a focus toggle that never types text) before the first real keypress.
const ensureInputLive = (view: Effect.Success<ReturnType<typeof renderWithRuntimeScoped>>, atRest: string) =>
  Effect.gen(function* () {
    yield* view.awaitFrame(atRest) // seeded + reconciled before warm-up
    yield* view.writeAndAwaitFrame("\t", "return create")
    yield* view.writeAndAwaitFrame("\t", "r rename")
    yield* view.awaitFrame(atRest) // round-trip preserved at-rest state
  })

describe("App mutation error line", () => {
  it.effect("renders a failed rename and clears it on the next successful mutation", () =>
    Effect.scoped(Effect.gen(function* () {
      const harness = yield* makeRuntimeHarnessScoped({
        snapshot: { projects: [fakeProject(1, "alpha")], seq: 0 },
        client: {
          rename: ({ name }) => Effect.fail(new ProjectNameConflict({ name }))
        }
      })
      const view = yield* renderWithRuntimeScoped(<App />, harness)
      yield* view.mounted
      yield* ensureInputLive(view, "▸ alpha")
      yield* view.writeAndAwaitFrame("r", "rename ▸") // rename overlay open
      let epoch = yield* view.captureFrameEpoch
      view.stdin.write("\r")
      yield* harness.observed.call("rename")
      yield* view.awaitFrameAfter(epoch, 'name conflict: "alpha" already exists')
      yield* view.writeAndAwaitFrame(
        "n", // focus create before typing
        "return create" // create focused (re-rendered)
      )
      yield* view.writeAndAwaitFrame("zen", "zen") // draft typed
      epoch = yield* view.captureFrameEpoch
      view.stdin.write("\r")
      yield* harness.observed.call("create")
      // The successful create clears the error; wait for the new project to land
      // (positive), then assert the conflict line is gone.
      yield* view.awaitFrameAfter(epoch, "• zen")
      expect(view.lastFrame()).not.toContain("name conflict")
      expect(view.lastFrame()).toContain("zen")
    })))

  it.effect("shows 'invalid input' when an invalid project name is submitted", () =>
    Effect.scoped(Effect.gen(function* () {
      const harness = yield* makeRuntimeHarnessScoped()
      const view = yield* renderWithRuntimeScoped(<App />, harness)
      yield* view.mounted
      yield* ensureInputLive(view, "no projects yet")
      yield* view.writeAndAwaitFrame(
        "n", // focus create before typing
        "return create" // create focused (re-rendered)
      )
      // "INVALID NAME!!!" contains uppercase + spaces — fails string regex
      yield* view.writeAndAwaitFrame("INVALID NAME!!!", "INVALID NAME!!!") // draft typed
      const epoch = yield* view.captureFrameEpoch
      view.stdin.write("\r")
      yield* harness.observed.call("create")
      yield* view.awaitFrameAfter(epoch, "invalid name")
      expect(view.lastFrame()).toContain("must match")
    })))
})
