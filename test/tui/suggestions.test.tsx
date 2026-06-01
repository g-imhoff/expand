import { describe, expect, it } from "vitest"
import { render } from "ink-testing-library"
import { Suggestions } from "@yodea/tui/components/suggestions"

const cmd = (name: string) => ({ id: name, name, description: `do ${name}`, run: () => {} })

describe("Suggestions", () => {
  it("renders nothing when empty", () => {
    const { lastFrame } = render(<Suggestions commands={[]} />)
    expect(lastFrame()).toBe("")
  })
  it("lists command names", () => {
    const { lastFrame } = render(<Suggestions commands={[cmd("new"), cmd("open")]} />)
    expect(lastFrame()).toContain("/new")
    expect(lastFrame()).toContain("/open")
  })
})
