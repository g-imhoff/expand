import { describe, expect, it, vi } from "vitest"
import { render } from "ink-testing-library"
import { ConfirmDelete } from "@yodea/tui/components/confirm-delete"

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("ConfirmDelete", () => {
  it("renders the project name and a y/n prompt", () => {
    const { lastFrame } = render(<ConfirmDelete projectName="alpha" onConfirm={() => {}} onCancel={() => {}} />)
    expect(lastFrame()).toContain("alpha")
    expect(lastFrame()).toMatch(/y\/n/i)
  })
  it("calls onConfirm when 'y' is pressed", async () => {
    const onConfirm = vi.fn()
    const { stdin } = render(<ConfirmDelete projectName="alpha" onConfirm={onConfirm} onCancel={() => {}} />)
    await flush()
    stdin.write("y")
    await flush()
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
  it("calls onCancel when 'n' is pressed", async () => {
    const onCancel = vi.fn()
    const { stdin } = render(<ConfirmDelete projectName="alpha" onConfirm={() => {}} onCancel={onCancel} />)
    await flush()
    stdin.write("n")
    await flush()
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
