import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import React from "react"
import { Effect } from "effect"
import { App } from "@expand/tui/components/app"
import { fakeProject, makeRuntimeHarnessScoped, renderWithRuntimeScoped } from "./runtime-harness"

// See app-input-routing.test.tsx for the full rationale. ink wires its input hook
// across two effects (raw-mode/readable, then the input-emitter subscription);
// between them a written key is read off stdin but routed to nobody and lost,
// because ink-testing-library emits "readable" once per write. Under load that
// window outlasts any fixed delay — the flake. So poll for observable outcomes,
// and warm the pipeline up with Tab (a focus toggle that never types text) until
// a key provably routes, before the first real keypress.
const ensureInputLive = (view: Effect.Success<ReturnType<typeof renderWithRuntimeScoped>>, atRest: string) =>
  Effect.gen(function* () {
    yield* view.awaitFrame(atRest) // seeded + reconciled before warm-up
    yield* view.writeAndAwaitFrame("\t", "return create")
    yield* view.writeAndAwaitFrame("\t", "r rename")
    yield* view.awaitFrame(atRest) // round-trip preserved selection
  })

describe("App archive keybinding", () => {
  it.effect("pressing 'a' archives the selected project", () =>
    Effect.scoped(Effect.gen(function* () {
      const harness = yield* makeRuntimeHarnessScoped({
        snapshot: { projects: [fakeProject(1, "alpha")], seq: 0 }
      })
      const view = yield* renderWithRuntimeScoped(<React.StrictMode><App /></React.StrictMode>, harness)
      yield* view.mounted
      yield* ensureInputLive(view, "▸ alpha") // selected + reconciled
      const epoch = yield* view.captureFrameEpoch
      view.stdin.write("a")
      yield* harness.observed.call("archive")
      const frame = yield* view.awaitFrameAfter(epoch, (current) => current.includes("[archived]"))
      expect(frame).toContain("[archived]")
      expect(harness.calls.archive).toHaveLength(1)
    })))

  it.effect("shows a project that is ALREADY archived at startup and restores it with 'a'", () =>
    Effect.scoped(Effect.gen(function* () {
      const harness = yield* makeRuntimeHarnessScoped({
        snapshot: { projects: [fakeProject(1, "alpha", { archived: true })], seq: 0 }
      })
      const view = yield* renderWithRuntimeScoped(<App />, harness)
      yield* view.mounted
      yield* ensureInputLive(view, "▸ alpha")
      expect(view.lastFrame()).toContain("[archived]")
      const epoch = yield* view.captureFrameEpoch
      view.stdin.write("a") // restore
      yield* harness.observed.call("restore")
      yield* harness.observed.snapshot((snapshot) => snapshot.projects[0]?.archived === false)
      yield* view.awaitFrameAfter(epoch, (frame) => !frame.includes("[archived]"))
      yield* view.awaitFrame("▸ alpha") // re-rendered after restore
      expect(view.lastFrame()).not.toContain("[archived]")
      expect(harness.calls.restore).toHaveLength(1)
    })))
})
