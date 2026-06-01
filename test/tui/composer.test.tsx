import { afterEach, describe, expect, it, vi } from "vitest"
import { render, cleanup } from "ink-testing-library"
import { Composer } from "@yodea/tui/components/composer"

const flush = () => new Promise((r) => setTimeout(r, 0))
afterEach(() => cleanup())

describe("Composer", () => {
  it("echoes typed characters", async () => {
    const { stdin, lastFrame } = render(<Composer isActive onSubmit={() => {}} />)
    await flush()
    stdin.write("gamma")
    await flush()
    expect(lastFrame()).toContain("gamma")
  })

  it("submits the raw line on Enter and clears the buffer", async () => {
    const onSubmit = vi.fn()
    const { stdin, lastFrame } = render(<Composer isActive onSubmit={onSubmit} />)
    await flush()
    stdin.write("/new delta")
    await flush()
    stdin.write("\r")
    await flush()
    expect(onSubmit).toHaveBeenCalledWith("/new delta")
    expect(lastFrame()).not.toContain("delta")
  })

  it("recalls the previous entry with the Up arrow", async () => {
    const { stdin, lastFrame } = render(<Composer isActive onSubmit={vi.fn()} />)
    await flush()
    stdin.write("alpha")
    await flush()
    stdin.write("\r") // commit "alpha" to history, clear buffer
    await flush()
    stdin.write("\x1B[A") // Up
    await flush()
    expect(lastFrame()).toContain("alpha")
  })

  it("shows slash-command suggestions while typing a command", async () => {
    const { stdin, lastFrame } = render(<Composer isActive onSubmit={vi.fn()} />)
    await flush()
    stdin.write("/pro")
    await flush()
    expect(lastFrame()).toContain("/projects")
  })

  it("ignores input when inactive", async () => {
    const onSubmit = vi.fn()
    const { stdin, lastFrame } = render(<Composer isActive={false} onSubmit={onSubmit} />)
    await flush()
    stdin.write("nope")
    await flush()
    stdin.write("\r")
    await flush()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(lastFrame()).not.toContain("nope")
  })
})
