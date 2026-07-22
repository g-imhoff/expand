import { it } from "@effect/vitest"
import { describe, expect, vi } from "vitest"
import React from "react"
import { Effect } from "effect"
import { App } from "@expand/tui/components/app"
import { fakeProject, makeRuntimeHarnessScoped, renderWithRuntimeScoped } from "./_runtime-harness"

const seed = (n: number, name: string) => fakeProject(n, name)
// Poll for an observable outcome instead of sleeping a fixed time: ink attaches
// its stdin listener and flushes renders on async ticks whose timing varies under
// load, so fixed delays are flaky. vi.waitFor re-runs the assertion until it
// settles.
const WAIT = { timeout: 2000, interval: 10 } as const
const waitForFrame = (lastFrame: () => string | undefined, text: string) =>
  Effect.tryPromise(() => vi.waitFor(() => expect(lastFrame()).toContain(text), WAIT))
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
const ensureInputLive = (
  stdin: Stdin, lastFrame: () => string | undefined, atRest: string
) => Effect.gen(function* () {
  yield* waitForFrame(lastFrame, atRest)
  yield* Effect.tryPromise(() => vi.waitFor(() => {
    if (has(lastFrame, "r rename")) stdin.write("\t")
    expect(lastFrame()).toContain("return create")
  }, WAIT))
  yield* Effect.tryPromise(() => vi.waitFor(() => {
    if (has(lastFrame, "return create")) stdin.write("\t")
    expect(lastFrame()).toContain("r rename")
  }, WAIT))
  yield* waitForFrame(lastFrame, atRest)
})

describe("App input routing (C1 regression, end-to-end)", () => {
  it.effect("typing a command-lettered name into the create field mutates nothing", () =>
    Effect.scoped(Effect.gen(function* () {
      const harness = yield* makeRuntimeHarnessScoped({
        snapshot: { projects: [seed(1, "alpha")], seq: 0 }
      })
      const { stdin, lastFrame } = yield* renderWithRuntimeScoped(<App />, harness)
      yield* ensureInputLive(stdin, lastFrame, "▸ alpha")
      stdin.write("n")
      yield* waitForFrame(lastFrame, "return create")
      stdin.write("data")
      yield* waitForFrame(lastFrame, "data")
      expect(lastFrame()).not.toContain("[archived]")
      expect(lastFrame()).not.toContain("directory ▸")
      stdin.write("\r")
      yield* Effect.tryPromise(() => vi.waitFor(() => {
        const projects = harness.authoritative.get().projects
        expect(projects).toHaveLength(2)
      }, WAIT))
      yield* waitForFrame(lastFrame, "• data")
      expect(lastFrame()).toContain("data")
      const projects = harness.authoritative.get().projects
      expect(projects.every((project) => project.archived === false)).toBe(true)
    })))

  it.effect("backspace while typing never opens the delete confirmation", () =>
    Effect.scoped(Effect.gen(function* () {
      const harness = yield* makeRuntimeHarnessScoped({
        snapshot: { projects: [seed(1, "alpha")], seq: 0 }
      })
      const { stdin, lastFrame } = yield* renderWithRuntimeScoped(<App />, harness)
      yield* ensureInputLive(stdin, lastFrame, "▸ alpha")
      stdin.write("n")
      yield* waitForFrame(lastFrame, "return create")
      stdin.write("xy")
      yield* waitForFrame(lastFrame, "xy")
      stdin.write("\x7f")
      yield* Effect.tryPromise(() => vi.waitFor(() => {
        expect(lastFrame()).toContain("new project ▸ x")
        expect(lastFrame()).not.toContain("xy")
      }, WAIT))
      expect(lastFrame()).not.toContain("delete “")
    })))

  it.effect("j/k navigate a real selection and commands act on it", () =>
    Effect.scoped(Effect.gen(function* () {
      const harness = yield* makeRuntimeHarnessScoped({
        snapshot: { projects: [seed(1, "alpha"), seed(2, "beta")], seq: 0 }
      })
      const { stdin, lastFrame } = yield* renderWithRuntimeScoped(<App />, harness)
      yield* ensureInputLive(stdin, lastFrame, "▸ alpha")
      stdin.write("j")
      yield* waitForFrame(lastFrame, "▸ beta")
      stdin.write("a")
      yield* Effect.tryPromise(() => vi.waitFor(() => {
        const projects = harness.authoritative.get().projects
        expect(projects.find((project) => project.name === "beta")?.archived).toBe(true)
      }, WAIT))
      const projects = harness.authoritative.get().projects
      expect(projects.find((project) => project.name === "alpha")?.archived).toBe(false)
      yield* waitForFrame(lastFrame, "[archived]")
    })))

  it.effect("metadata overlay: description + tags with tab switch (C8 parity)", () =>
    Effect.scoped(Effect.gen(function* () {
      const harness = yield* makeRuntimeHarnessScoped({
        snapshot: { projects: [seed(1, "alpha")], seq: 0 }
      })
      const { stdin, lastFrame } = yield* renderWithRuntimeScoped(<App />, harness)
      yield* ensureInputLive(stdin, lastFrame, "▸ alpha")
      stdin.write("m")
      yield* waitForFrame(lastFrame, "description ▸")
      stdin.write("hello")
      yield* waitForFrame(lastFrame, "hello")
      stdin.write("\t")
      yield* waitForFrame(lastFrame, "tags (a, b) ▸")
      stdin.write("api, db")
      yield* waitForFrame(lastFrame, "api, db")
      stdin.write("\r")
      yield* Effect.tryPromise(() => vi.waitFor(() => {
        const projects = harness.authoritative.get().projects
        expect(projects[0]?.description).toBe("hello")
        expect(projects[0]?.tags).toEqual(["api", "db"])
      }, WAIT))
    })))

  it.effect("escape cancels metadata with zero mutations (C8: cancel exists now)", () =>
    Effect.scoped(Effect.gen(function* () {
      const harness = yield* makeRuntimeHarnessScoped({
        snapshot: { projects: [seed(1, "alpha")], seq: 0 }
      })
      const { stdin, lastFrame } = yield* renderWithRuntimeScoped(<App />, harness)
      yield* ensureInputLive(stdin, lastFrame, "▸ alpha")
      stdin.write("m")
      yield* waitForFrame(lastFrame, "description ▸")
      stdin.write("oops")
      yield* waitForFrame(lastFrame, "oops")
      stdin.write("\x1b")
      yield* waitForFrame(lastFrame, "new project ▸")
      expect(lastFrame()).not.toContain("description ▸")
      const projects = harness.authoritative.get().projects
      expect(projects[0]?.description).toBeNull()
    })))

  it.effect("hint bar reflects the active context", () =>
    Effect.scoped(Effect.gen(function* () {
      const harness = yield* makeRuntimeHarnessScoped({
        snapshot: { projects: [seed(1, "alpha")], seq: 0 }
      })
      const { stdin, lastFrame } = yield* renderWithRuntimeScoped(<App />, harness)
      yield* ensureInputLive(stdin, lastFrame, "▸ alpha")
      expect(lastFrame()).toContain("r rename")
      stdin.write("x")
      yield* waitForFrame(lastFrame, "y confirm")
      expect(lastFrame()).not.toContain("r rename")
    })))
})
