import { describe, expect, it, vi } from "vitest"
import { render } from "ink-testing-library"
import { RenameInput } from "@yodea/tui/components/rename-input"

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const flushEscape = () => new Promise((resolve) => setTimeout(resolve, 40))

describe("RenameInput", () => {
  it("prefills the current name", async () => {
    const { lastFrame } = render(<RenameInput current="alpha" onSubmit={() => {}} onCancel={() => {}} />)
    await flush()
    expect(lastFrame()).toContain("alpha")
  })
  it("submits the edited value on Enter", async () => {
    const onSubmit = vi.fn()
    const { stdin } = render(<RenameInput current="alpha" onSubmit={onSubmit} onCancel={() => {}} />)
    await flush()
    stdin.write("2")
    await flush()
    stdin.write("\r")
    await flush()
    expect(onSubmit).toHaveBeenCalledWith("alpha2")
  })
  it("cancels on Escape", async () => {
    const onCancel = vi.fn()
    const { stdin } = render(<RenameInput current="alpha" onSubmit={() => {}} onCancel={onCancel} />)
    await flush()
    stdin.write("")
    await flushEscape()
    expect(onCancel).toHaveBeenCalled()
  })
})
