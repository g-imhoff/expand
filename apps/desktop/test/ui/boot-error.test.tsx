// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest"
import { render, fireEvent } from "@testing-library/react"
import { BootError } from "@yodea/desktop/renderer/app/BootError"

describe("BootError", () => {
  it("renders the failure in a role=alert block with a Retry button", () => {
    const onRetry = vi.fn()
    const { getByRole } = render(<BootError message="boot timed out" onRetry={onRetry} />)
    expect(getByRole("alert").textContent).toContain("boot timed out")
    fireEvent.click(getByRole("button", { name: "Retry" }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})
