// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest"
import { render, fireEvent } from "@testing-library/react"
import { RenameDialog } from "@yodea/desktop/renderer/features/projects/RenameDialog"

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
})
