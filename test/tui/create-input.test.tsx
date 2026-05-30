import { describe, expect, it, vi } from "vitest"
import { render } from "ink-testing-library"
import { CreateInput } from "@yodea/tui/components/create-input"

// ink 7 + ink-testing-library 4: useInput attaches its readable listener in an
// effect that runs after the initial commit, so writes must happen after a flush
// (a macrotask tick) — otherwise the input is dropped before the listener exists.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("CreateInput", () => {
  it("echoes typed characters", async () => {
    const { stdin, lastFrame } = render(<CreateInput onSubmit={() => {}} />)
    await flush()
    stdin.write("gamma")
    await flush()
    expect(lastFrame()).toContain("gamma")
  })
  it("submits the trimmed value on Enter and clears", async () => {
    const onSubmit = vi.fn()
    const { stdin, lastFrame } = render(<CreateInput onSubmit={onSubmit} />)
    await flush()
    stdin.write("delta")
    await flush()
    stdin.write("\r") // Enter
    await flush()
    expect(onSubmit).toHaveBeenCalledWith("delta")
    expect(lastFrame()).not.toContain("delta")
  })
})
