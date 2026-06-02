import { describe, expect, it, vi } from "vitest"
import { render } from "ink-testing-library"
import { DirectoryInput } from "@yodea/tui/components/directory-input"

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
// ink buffers a lone ESC (pendingInputFlushDelayMilliseconds, ~20ms) before
// flushing it as the Escape key; wait comfortably past that so the cancel
// handler runs (a tight ~40ms wait was flaky in this environment).
const flushEscape = () => new Promise((resolve) => setTimeout(resolve, 80))

describe("DirectoryInput", () => {
  it("echoes typed characters with the project name in the prompt", async () => {
    const { stdin, lastFrame } = render(<DirectoryInput projectName="alpha" onSubmit={() => {}} onCancel={() => {}} />)
    await flush(); stdin.write("/srv/a"); await flush()
    expect(lastFrame()).toContain("/srv/a")
    expect(lastFrame()).toContain("alpha")
  })
  it("submits the trimmed path on Enter", async () => {
    const onSubmit = vi.fn()
    const { stdin } = render(<DirectoryInput projectName="alpha" onSubmit={onSubmit} onCancel={() => {}} />)
    await flush(); stdin.write("/srv/a"); await flush(); stdin.write("\r"); await flush()
    expect(onSubmit).toHaveBeenCalledWith("/srv/a")
  })
  it("cancels on Escape", async () => {
    const onCancel = vi.fn()
    const { stdin } = render(<DirectoryInput projectName="alpha" onSubmit={() => {}} onCancel={onCancel} />)
    await flush(); stdin.write("\x1b"); await flushEscape()
    expect(onCancel).toHaveBeenCalled()
  })
})
