import { describe, expect, it, vi } from "vitest"
import React from "react"
import { App } from "@expand/tui/components/app"
import { fakeProject, makeRuntimeHarness, renderWithRuntime } from "./_runtime-harness"

// See app-input-routing.test.tsx for the full rationale. ink wires its input hook
// across two effects (raw-mode/readable, then the input-emitter subscription);
// between them a written key is read off stdin but routed to nobody and lost,
// because ink-testing-library emits "readable" once per write. Under load that
// window outlasts any fixed delay — the flake. So poll for observable outcomes,
// and warm the pipeline up with Tab (a focus toggle that never types text) until
// a key provably routes, before the first real keypress.
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

describe("App archive keybinding", () => {
  it("pressing 'a' archives the selected project", async () => {
    const harness = makeRuntimeHarness({
      snapshot: { projects: [fakeProject(1, "alpha")], seq: 0 }
    })
    try {
      const { stdin, lastFrame } = renderWithRuntime(<App />, harness)
      await ensureInputLive(stdin, lastFrame, "▸ alpha")
      stdin.write("a")
      await waitForFrame(lastFrame, "[archived]")
    } finally {
      await harness.dispose()
    }
  })

  it("shows a project that is ALREADY archived at startup and restores it with 'a'", async () => {
    const harness = makeRuntimeHarness({
      snapshot: { projects: [fakeProject(1, "alpha", { archived: true })], seq: 0 }
    })
    try {
      const { stdin, lastFrame } = renderWithRuntime(<App />, harness)
      await ensureInputLive(stdin, lastFrame, "▸ alpha") // selected + reconciled
      expect(lastFrame()).toContain("[archived]")
      stdin.write("a") // restore
      await vi.waitFor(async () => {
        const ps = harness.authoritative.get().projects
        expect(ps[0]?.archived).toBe(false)
      }, WAIT)
      await vi.waitFor(() => expect(lastFrame()).not.toContain("[archived]"), WAIT)
      await waitForFrame(lastFrame, "▸ alpha") // re-rendered after restore
      expect(lastFrame()).not.toContain("[archived]")
    } finally {
      await harness.dispose()
    }
  })
})
