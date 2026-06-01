import { describe, expect, it } from "vitest"
import { render } from "ink-testing-library"
import { ErrorView } from "@yodea/tui/components/error-view"

describe("ErrorView", () => {
  it("renders the headline and the message", () => {
    const { lastFrame } = render(<ErrorView message="backend unavailable" />)
    expect(lastFrame()).toContain("Something went wrong")
    expect(lastFrame()).toContain("backend unavailable")
  })
})
