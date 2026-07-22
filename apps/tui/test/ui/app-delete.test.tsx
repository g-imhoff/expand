import { it } from "@effect/vitest"
import { describe, expect, vi } from "vitest"
import React from "react"
import { Effect } from "effect"
import { App } from "@expand/tui/components/app"
import { fakeProject, makeRuntimeHarnessScoped, renderWithRuntimeScoped } from "./_runtime-harness"

// See app-input-routing.test.tsx for the full rationale. ink wires its input hook
// across two effects; between them a written key is read off stdin but routed to
// nobody and lost. Under load that window outlasts any fixed delay — the flake.
// So poll for observable outcomes, and warm the pipeline up with Tab (a focus
// toggle that never types text) before the first real keypress.
const WAIT = { timeout: 2000, interval: 10 } as const
const waitForFrame = (lastFrame: () => string | undefined, text: string) =>
  Effect.tryPromise(() => vi.waitFor(() => expect(lastFrame()).toContain(text), WAIT))
const has = (lastFrame: () => string | undefined, text: string) =>
  (lastFrame() ?? "").includes(text)
const ensureInputLive = (
  stdin: { write: (s: string) => void }, lastFrame: () => string | undefined, atRest: string
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

describe("App delete keybinding", () => {
  it.effect("pressing 'x' opens the confirm prompt and 'y' deletes the project", () =>
    Effect.scoped(Effect.gen(function* () {
      const harness = yield* makeRuntimeHarnessScoped({
        snapshot: { projects: [fakeProject(1, "alpha")], seq: 0 }
      })
      const { stdin, lastFrame } = yield* renderWithRuntimeScoped(<App />, harness)
      yield* ensureInputLive(stdin, lastFrame, "▸ alpha")
      stdin.write("x")
      yield* waitForFrame(lastFrame, "delete")
      expect(lastFrame()).toContain("alpha")
      stdin.write("y")
      yield* Effect.tryPromise(() => vi.waitFor(() => {
        const remaining = harness.authoritative.get().projects
        expect(remaining).toHaveLength(0)
      }, WAIT))
    })))

  it.effect("pressing 'x' then Escape cancels without deleting", () =>
    Effect.scoped(Effect.gen(function* () {
      const harness = yield* makeRuntimeHarnessScoped({
        snapshot: { projects: [fakeProject(1, "alpha")], seq: 0 }
      })
      const { stdin, lastFrame } = yield* renderWithRuntimeScoped(<App />, harness)
      yield* ensureInputLive(stdin, lastFrame, "▸ alpha")
      stdin.write("x")
      yield* waitForFrame(lastFrame, "delete")
      stdin.write("\x1b")
      yield* waitForFrame(lastFrame, "r rename")
      const remaining = harness.authoritative.get().projects
      expect(remaining).toHaveLength(1)
    })))
})
