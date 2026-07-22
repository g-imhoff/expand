import { it } from "@effect/vitest"
import { describe, expect, vi } from "vitest"
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

describe("App mutation error line", () => {
  it.effect("renders a failed rename and clears it on the next successful mutation", () =>
    Effect.scoped(Effect.gen(function* () {
      const harness = yield* makeRuntimeHarnessScoped({
        snapshot: { projects: [fakeProject(1, "alpha")], seq: 0 },
        client: {
          rename: ({ name }) => Effect.fail(new ProjectNameConflict({ name }))
        }
      })
      const { stdin, lastFrame } = yield* renderWithRuntimeScoped(<App />, harness)
      yield* ensureInputLive(stdin, lastFrame, "▸ alpha")
      stdin.write("r")
      yield* waitForFrame(lastFrame, "rename ▸")
      stdin.write("\r")
      yield* waitForFrame(lastFrame, 'name conflict: "alpha" already exists')
      stdin.write("n")
      yield* waitForFrame(lastFrame, "return create")
      stdin.write("zen")
      yield* waitForFrame(lastFrame, "zen")
      stdin.write("\r")
      yield* waitForFrame(lastFrame, "• zen")
      expect(lastFrame()).not.toContain("name conflict")
      expect(lastFrame()).toContain("zen")
    })))

  it.effect("shows 'invalid input' when an invalid project name is submitted", () =>
    Effect.scoped(Effect.gen(function* () {
      const harness = yield* makeRuntimeHarnessScoped()
      const { stdin, lastFrame } = yield* renderWithRuntimeScoped(<App />, harness)
      yield* ensureInputLive(stdin, lastFrame, "no projects yet")
      stdin.write("n")
      yield* waitForFrame(lastFrame, "return create")
      stdin.write("INVALID NAME!!!")
      yield* waitForFrame(lastFrame, "INVALID NAME!!!")
      stdin.write("\r")
      yield* waitForFrame(lastFrame, "invalid name")
      expect(lastFrame()).toContain("must match")
    })))
})
