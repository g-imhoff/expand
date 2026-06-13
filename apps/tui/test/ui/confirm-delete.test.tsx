import { describe, expect, it } from "vitest"
import React from "react"
import { render } from "ink-testing-library"
import { ConfirmDelete } from "@yodea/tui/components/confirm-delete"

describe("ConfirmDelete", () => {
  it("renders the project name and the y/n hint", () => {
    const { lastFrame } = render(<ConfirmDelete projectName="data" />)
    expect(lastFrame()).toContain("delete “data”?")
    expect(lastFrame()).toContain("(y/n)")
  })
})
