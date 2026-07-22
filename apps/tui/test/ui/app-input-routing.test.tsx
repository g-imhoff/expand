import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import React from "react"
import { Effect } from "effect"
import { App } from "@expand/tui/components/app"
import { fakeProject, makeRuntimeHarnessScoped, renderWithRuntimeScoped } from "./_runtime-harness"

const seed = (n: number, name: string) => fakeProject(n, name)
// Poll for an observable outcome instead of sleeping a fixed time: ink attaches
// its stdin listener and flushes renders on async ticks whose timing varies under
// load, so fixed delays are flaky. vi.waitFor re-runs the assertion until it
// settles.
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
// `atRest` is a frame substring that proves the App finished loading its SEEDED
// projects and reconciled (e.g. the selection marker "▸ alpha"). The projects
// arrive on a background fiber, so the very first render is always empty — the
// caller must hand us the post-load signal so we don't warm up prematurely.
const ensureInputLive = (view: Effect.Success<ReturnType<typeof renderWithRuntimeScoped>>, atRest: string) =>
  Effect.gen(function* () {
    // Wait for the seeded, reconciled state. The warm-up below writes Tab, which
    // calls setUi({...ui, focus}); if it ran before reconcile set the selection it
    // would spread a selectedId=null state and clobber the selection.
    yield* view.awaitFrame(atRest)
    view.stdin.write("\t")    // list → nudge to create
    yield* view.awaitFrame("return create")       // create hint = routed
    view.stdin.write("\t") // create → nudge to list
    yield* view.awaitFrame("r rename")             // back at rest
    // Confirm the round-trip preserved the at-rest seeded state.
    yield* view.awaitFrame(atRest)
  })

describe("App input routing (C1 regression, end-to-end)", () => {
  it.effect("typing a command-lettered name into the create field mutates nothing", () =>
    Effect.scoped(Effect.gen(function* () {
      const harness = yield* makeRuntimeHarnessScoped({
        snapshot: { projects: [seed(1, "alpha")], seq: 0 }
      })
      const view = yield* renderWithRuntimeScoped(<App />, harness)
      yield* view.mounted
      yield* ensureInputLive(view, "▸ alpha")
      view.stdin.write("n")          // focus create (list is focused by default)
      yield* view.awaitFrame("return create") // create field focused (re-rendered)
      view.stdin.write("data")       // contains d (dir), a (archive!), t, a
      yield* view.awaitFrame("data")          // draft visible — step processed
      expect(view.lastFrame()).not.toContain("[archived]")  // 'a' did NOT archive
      expect(view.lastFrame()).not.toContain("directory ▸") // 'd' did NOT open dir overlay
      view.stdin.write("\r")         // submit
      yield* harness.observed.call("create")
      yield* harness.observed.snapshot((snapshot) => snapshot.projects.length === 2)
      expect(harness.authoritative.get().projects).toHaveLength(2)               // project created
      yield* view.awaitFrame("• data")
      expect(view.lastFrame()).toContain("data")
      const projects = harness.authoritative.get().projects
      expect(projects.every((project) => project.archived === false)).toBe(true)
    })))

  it.effect("backspace while typing never opens the delete confirmation", () =>
    Effect.scoped(Effect.gen(function* () {
      const harness = yield* makeRuntimeHarnessScoped({
        snapshot: { projects: [seed(1, "alpha")], seq: 0 }
      })
      const view = yield* renderWithRuntimeScoped(<App />, harness)
      yield* view.mounted
      yield* ensureInputLive(view, "▸ alpha")
      view.stdin.write("n")
      yield* view.awaitFrame("return create") // create field focused (re-rendered)
      view.stdin.write("xy")
      yield* view.awaitFrame("xy")            // both chars typed
      view.stdin.write("\x7f") // backspace (DEL)
      // After the edit settles to "x" (draft no longer shows "xy"), the negative
      // — no delete overlay — can be asserted at a settled state.
      yield* view.awaitFrame((frame) => frame.includes("new project ▸ x") && !frame.includes("xy"))
      expect(view.lastFrame()).toContain("new project ▸ x") // draft edited to "x"
      expect(view.lastFrame()).not.toContain("delete “")
    })))

  it.effect("j/k navigate a real selection and commands act on it", () =>
    Effect.scoped(Effect.gen(function* () {
      const harness = yield* makeRuntimeHarnessScoped({
        snapshot: { projects: [seed(1, "alpha"), seed(2, "beta")], seq: 0 }
      })
      const view = yield* renderWithRuntimeScoped(<App />, harness)
      yield* view.mounted
      yield* ensureInputLive(view, "▸ alpha")
      view.stdin.write("j") // select beta
      yield* view.awaitFrame("▸ beta") // selection moved to beta
      view.stdin.write("a") // archive SELECTED (beta), not projects[0]
      yield* harness.observed.call("archive")
      yield* harness.observed.snapshot(
        (snapshot) => snapshot.projects.find((project) => project.name === "beta")?.archived === true
      )
      const projects = harness.authoritative.get().projects
      expect(projects.find((project) => project.name === "alpha")?.archived).toBe(false)
      yield* view.awaitFrame("[archived]")
    })))

  it.effect("metadata overlay: description + tags with tab switch (C8 parity)", () =>
    Effect.scoped(Effect.gen(function* () {
      const harness = yield* makeRuntimeHarnessScoped({
        snapshot: { projects: [seed(1, "alpha")], seq: 0 }
      })
      const view = yield* renderWithRuntimeScoped(<App />, harness)
      yield* view.mounted
      yield* ensureInputLive(view, "▸ alpha")
      view.stdin.write("m")
      yield* view.awaitFrame("description ▸") // metadata overlay open
      view.stdin.write("hello")
      yield* view.awaitFrame("hello")         // description draft visible
      view.stdin.write("\t") // switch to tags
      // tags field becomes focused; type into it once the switch settled.
      yield* view.awaitFrame("tags (a, b) ▸")
      view.stdin.write("api, db")
      yield* view.awaitFrame("api, db")       // tags draft visible
      view.stdin.write("\r") // submit both
      yield* harness.observed.call("setMetadata")
      yield* harness.observed.snapshot((snapshot) =>
        snapshot.projects[0]?.description === "hello" &&
        snapshot.projects[0]?.tags.join("\0") === "api\0db"
      )
    })))

  it.effect("escape cancels metadata with zero mutations (C8: cancel exists now)", () =>
    Effect.scoped(Effect.gen(function* () {
      const harness = yield* makeRuntimeHarnessScoped({
        snapshot: { projects: [seed(1, "alpha")], seq: 0 }
      })
      const view = yield* renderWithRuntimeScoped(<App />, harness)
      yield* view.mounted
      yield* ensureInputLive(view, "▸ alpha")
      view.stdin.write("m")
      yield* view.awaitFrame("description ▸") // metadata overlay open
      view.stdin.write("oops")
      yield* view.awaitFrame("oops")          // draft typed
      view.stdin.write("\x1b") // escape
      // The overlay closing is observable as the create field returning; once the
      // create field is back, the metadata overlay is provably gone.
      yield* view.awaitFrame("new project ▸")
      expect(view.lastFrame()).not.toContain("description ▸")
      const projects = harness.authoritative.get().projects
      expect(projects[0]?.description).toBeNull()
    })))

  it.effect("hint bar reflects the active context", () =>
    Effect.scoped(Effect.gen(function* () {
      const harness = yield* makeRuntimeHarnessScoped({
        snapshot: { projects: [seed(1, "alpha")], seq: 0 }
      })
      const view = yield* renderWithRuntimeScoped(<App />, harness)
      yield* view.mounted
      yield* ensureInputLive(view, "▸ alpha")
      expect(view.lastFrame()).toContain("r rename")   // list context
      view.stdin.write("x")
      // Wait for the confirm context to be active; once "y confirm" shows, the
      // list hint must be gone, so the negative is asserted at a settled state.
      yield* view.awaitFrame("y confirm")  // confirm context
      expect(view.lastFrame()).not.toContain("r rename")
    })))
})
