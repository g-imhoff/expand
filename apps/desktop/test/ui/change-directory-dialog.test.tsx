// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest"
import { render, fireEvent } from "@testing-library/react"
import { ProjectId } from "@yodea/contracts/project"
import type { ProjectId as ProjectIdType } from "@yodea/contracts/project"
import { ChangeDirectoryDialog } from "@yodea/desktop/renderer/features/projects/components/ChangeDirectoryDialog"

const uid = (n: number): string => "00000000-0000-4000-8000-" + String(n).padStart(12, "0")

describe("ChangeDirectoryDialog", () => {
  it("prefills the current directory and submits the new path", () => {
    const onChangeDirectory = vi.fn()
    const changeDirectoryCalls: Array<{ id: ProjectIdType; directory: string }> = []
    const { getByLabelText, getByText } = render(
      <ChangeDirectoryDialog
        open
        project={{ id: ProjectId.make(uid(1)), name: "alpha", directory: "/old" }}
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
    expect(onChangeDirectory).toHaveBeenCalledWith(uid(1), "/srv/a")
    expect(changeDirectoryCalls).toContainEqual({ id: uid(1), directory: "/srv/a" })
  })

  it("surfaces a directory error in a role=alert block", () => {
    const { getByRole } = render(
      <ChangeDirectoryDialog
        open
        project={{ id: ProjectId.make(uid(1)), name: "alpha", directory: null }}
        onOpenChange={() => {}}
        onChangeDirectory={() => {}}
        error={{ _tag: "ProjectDirectoryInvalid", directory: "/bad", reason: "not-found" }}
      />
    )
    expect(getByRole("alert").textContent).toContain("ProjectDirectoryInvalid")
  })
})
