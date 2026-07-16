import { describe, expect, it } from "vitest"
import React from "react"
import { render } from "ink-testing-library"
import { ConfirmDelete } from "@expand/tui/components/confirm-delete"

describe("ConfirmDelete", () => {
  it("renders the project name and the y/n hint", () => {
    const view = render(<ConfirmDelete projectName="data" />)
    expect(view.lastFrame()).toContain("delete “data”?")
    expect(view.lastFrame()).toContain("(y/n)")
    view.unmount()
  })
})
