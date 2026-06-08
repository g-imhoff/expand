// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { DeleteProjectDialog } from "@yodea/desktop/renderer/features/projects/components/DeleteProjectDialog"

describe("DeleteProjectDialog", () => {
  it("shows the project name and calls onConfirm when Delete is clicked", () => {
    const onConfirm = vi.fn()
    render(
      <DeleteProjectDialog
        open
        projectName="alpha"
        pending={false}
        onOpenChange={() => {}}
        onConfirm={onConfirm}
      />
    )
    expect(screen.getByText(/alpha/)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
  it("calls onOpenChange(false) when Cancel is clicked", () => {
    const onOpenChange = vi.fn()
    render(
      <DeleteProjectDialog open projectName="alpha" pending={false} onOpenChange={onOpenChange} onConfirm={() => {}} />
    )
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
