import { describe, expect, it, vi } from "vitest"
import React from "react"
import { App } from "@expand/tui/components/app"
import { fakeProject, makeRuntimeHarness, renderWithRuntime } from "./_runtime-harness"

// See app-input-routing.test.tsx for the full rationale. ink wires its input hook
// across two effects; between them a written key is read off stdin but routed to
// nobody and lost. Under load that window outlasts any fixed delay — the flake.
// So poll for observable outcomes, and warm the pipeline up with Tab (a focus
// toggle that never types text) before the first real keypress.
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
  await waitForFrame(lastFrame, atRest) // round-trip preserved selection
}

describe("App delete keybinding", () => {
  it("pressing 'x' opens the confirm prompt and 'y' deletes the project", async () => {
    const harness = makeRuntimeHarness({
      snapshot: { projects: [fakeProject(1, "alpha")], seq: 0 }
    })
    try {
      const { stdin, lastFrame } = renderWithRuntime(<App />, harness)
      await ensureInputLive(stdin, lastFrame, "▸ alpha")
      stdin.write("x")
      await waitForFrame(lastFrame, "delete") // confirm prompt open
      expect(lastFrame()).toContain("alpha")
      stdin.write("y")
      await vi.waitFor(async () => {
        const remaining = harness.authoritative.get().projects
        expect(remaining).toHaveLength(0)
      }, WAIT)
    } finally {
      await harness.dispose()
    }
  })

  it("pressing 'x' then Escape cancels without deleting", async () => {
    const harness = makeRuntimeHarness({
      snapshot: { projects: [fakeProject(1, "alpha")], seq: 0 }
    })
    try {
      const { stdin, lastFrame } = renderWithRuntime(<App />, harness)
      await ensureInputLive(stdin, lastFrame, "▸ alpha")
      stdin.write("x")
      await waitForFrame(lastFrame, "delete") // confirm prompt open
      stdin.write("\x1b") // escape cancels
      // Cancel completing is observable as the confirm prompt closing — the list
      // hint returns. Once back at rest, assert the project is still there.
      await waitForFrame(lastFrame, "r rename")
      const remaining = harness.authoritative.get().projects
      expect(remaining).toHaveLength(1)
    } finally {
      await harness.dispose()
    }
  })
})
