// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest"
import { render, fireEvent } from "@testing-library/react"
import { ChangeDirectoryDialog } from "@yodea/desktop/renderer/features/projects/components/ChangeDirectoryDialog"

describe("ChangeDirectoryDialog", () => {
  it("prefills the current directory and submits the new path", () => {
    const onChangeDirectory = vi.fn()
    const changeDirectoryCalls: Array<{ id: string; directory: string }> = []
    const { getByLabelText, getByText } = render(
      <ChangeDirectoryDialog
        open
        project={{ id: "a", name: "alpha", directory: "/old" }}
        onOpenChange={() => {}}
        onChangeDirectory={(id, directory) => {
          onChangeDirectory(id, directory)
          changeDirectoryCalls.push({ id, directory })
        }}
      />
    )
    const input = getByLabelText("project directory") as HTMLInputElement
    expect(input.value).toBe("/old")
    fireEvent.change(input, { target: { value: "/srv/a" } })
    fireEvent.click(getByText("Save"))
    expect(onChangeDirectory).toHaveBeenCalledWith("a", "/srv/a")
    expect(changeDirectoryCalls).toContainEqual({ id: "a", directory: "/srv/a" })
  })

  it("surfaces a directory error in a role=alert block", () => {
    const { getByRole } = render(
      <ChangeDirectoryDialog
        open
        project={{ id: "a", name: "alpha", directory: null }}
        onOpenChange={() => {}}
        onChangeDirectory={() => {}}
        error={{ _tag: "ProjectDirectoryInvalid", directory: "/bad", reason: "not-found" }}
      />
    )
    expect(getByRole("alert").textContent).toContain("ProjectDirectoryInvalid")
  })
})
