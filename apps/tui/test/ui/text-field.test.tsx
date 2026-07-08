import { describe, expect, it } from "vitest"
import React from "react"
import { render } from "ink-testing-library"
import { textField } from "@expand/ink-input/text-field"
import { TextField } from "@expand/tui/components/text-field"

describe("TextField", () => {
  it("renders label and value", () => {
    const { lastFrame } = render(<TextField label="rename ▸ " state={textField("data")} focused={false} />)
    expect(lastFrame()).toContain("rename ▸")
    expect(lastFrame()).toContain("data")
  })
  it("shows a cursor glyph only when focused", () => {
    const focused = render(<TextField label="new ▸ " state={textField("x")} focused={true} />)
    expect(focused.lastFrame()).toContain("▍")
    const blurred = render(<TextField label="new ▸ " state={textField("x")} focused={false} />)
    expect(blurred.lastFrame()).not.toContain("▍")
  })
})
