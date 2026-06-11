// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest"
import { render, fireEvent } from "@testing-library/react"
import { RenameDialog } from "@yodea/desktop/renderer/features/projects/components/RenameDialog"

describe("RenameDialog", () => {
  it("prefills the current name and submits the new name", () => {
    const onRename = vi.fn()
    const { getByLabelText, getByText } = render(
      <RenameDialog open project={{ id: "a", name: "alpha" }} onOpenChange={() => {}} onRename={onRename} />
    )
    const input = getByLabelText("new project name") as HTMLInputElement
    expect(input.value).toBe("alpha")
    fireEvent.change(input, { target: { value: "alpha-2" } })
    fireEvent.click(getByText("Rename"))
    expect(onRename).toHaveBeenCalledWith("a", "alpha-2")
  })
  it("surfaces a rename error in a role=alert block and does not close itself on submit", () => {
    const onOpenChange = vi.fn()
    const { getByRole } = render(
      <RenameDialog
        open
        project={{ id: "a", name: "alpha" }}
        onOpenChange={onOpenChange}
        onRename={() => {}}
        error={{ _tag: "ProjectNameConflict", name: "alpha" }}
      />
    )
    expect(getByRole("alert").textContent).toContain("ProjectNameConflict")
    fireEvent.click(getByRole("button", { name: "Rename" }))
    expect(onOpenChange).not.toHaveBeenCalled()
  })
})
