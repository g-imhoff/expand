import { describe, expect, it, vi } from "vitest"
import React from "react"
import { Effect } from "effect"
import { ProjectNameConflict } from "@expand/contracts/rpc"
import { App } from "@expand/tui/components/app"
import { fakeProject, makeRuntimeHarness, renderWithRuntime } from "./_runtime-harness"

// See app-input-routing.test.tsx for the full rationale. ink wires its input hook
// across two effects; between them a written key is read off stdin but routed to
// nobody and lost — and that window outlasts any fixed delay under load, which
// is the flake. So poll for observable outcomes, and warm the pipeline up with
// Tab (a focus toggle that never types text) before the first real keypress.
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
  await waitForFrame(lastFrame, atRest) // round-trip preserved at-rest state
}

describe("App mutation error line", () => {
  it("renders a failed rename and clears it on the next successful mutation", async () => {
    const harness = makeRuntimeHarness({
      snapshot: { projects: [fakeProject(1, "alpha")], seq: 0 },
      client: {
        rename: ({ name }) => Effect.fail(new ProjectNameConflict({ name }))
      }
    })
    try {
      const { stdin, lastFrame } = renderWithRuntime(<App />, harness)
      await ensureInputLive(stdin, lastFrame, "▸ alpha")
      stdin.write("r")
      await waitForFrame(lastFrame, "rename ▸") // rename overlay open
      stdin.write("\r")
      await waitForFrame(lastFrame, 'name conflict: "alpha" already exists')
      stdin.write("n") // focus create before typing
      await waitForFrame(lastFrame, "return create") // create focused (re-rendered)
      stdin.write("zen")
      await waitForFrame(lastFrame, "zen") // draft typed
      stdin.write("\r")
      // The successful create clears the error; wait for the new project to land
      // (positive), then assert the conflict line is gone.
      await waitForFrame(lastFrame, "• zen")
      expect(lastFrame()).not.toContain("name conflict")
      expect(lastFrame()).toContain("zen")
    } finally {
      await harness.dispose()
    }
  })

  it("shows 'invalid input' when an invalid project name is submitted", async () => {
    const harness = makeRuntimeHarness()
    try {
      const { stdin, lastFrame } = renderWithRuntime(<App />, harness)
      await ensureInputLive(stdin, lastFrame, "no projects yet")
      stdin.write("n") // focus create before typing
      await waitForFrame(lastFrame, "return create") // create focused (re-rendered)
      // "INVALID NAME!!!" contains uppercase + spaces — fails string regex
      stdin.write("INVALID NAME!!!")
      await waitForFrame(lastFrame, "INVALID NAME!!!") // draft typed
      stdin.write("\r")
      await waitForFrame(lastFrame, "invalid name")
      expect(lastFrame()).toContain("must match")
    } finally {
      await harness.dispose()
    }
  })
})
