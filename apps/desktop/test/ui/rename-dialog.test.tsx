// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest"
import { render, fireEvent } from "@testing-library/react"
import { ProjectInvalidInput } from "@yodea/contracts/rpc"
import { RenameDialog } from "@yodea/desktop/renderer/features/projects/components/RenameDialog"

const uid = (n: number): string => "00000000-0000-4000-8000-" + String(n).padStart(12, "0")

describe("RenameDialog", () => {
  it("prefills the current name and submits the new name", () => {
    const onRename = vi.fn()
    const { getByLabelText, getByText } = render(
      <RenameDialog open project={{ id: uid(1), name: "alpha" }} onOpenChange={() => {}} onRename={onRename} />
    )
    const input = getByLabelText("new project name") as HTMLInputElement
    expect(input.value).toBe("alpha")
    fireEvent.change(input, { target: { value: "alpha-2" } })
    fireEvent.click(getByText("Rename"))
    expect(onRename).toHaveBeenCalledWith(uid(1), "alpha-2")
  })
  it("surfaces a rename error in a role=alert block and does not close itself on submit", () => {
    const onOpenChange = vi.fn()
    const { getByRole } = render(
      <RenameDialog
        open
        project={{ id: uid(1), name: "alpha" }}
        onOpenChange={onOpenChange}
        onRename={() => {}}
        error={{ _tag: "ProjectNameConflict", name: "alpha" }}
      />
    )
    expect(getByRole("alert").textContent).toContain("ProjectNameConflict")
    fireEvent.click(getByRole("button", { name: "Rename" }))
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it("renders a backend validation error (ProjectInvalidInput) in the alert", () => {
    // Invalid input is now validated at the server's ingestion boundary and comes
    // back as a typed ProjectInvalidInput; describeError renders `invalid <field>: <reason>`.
    const { getByRole } = render(
      <RenameDialog
        open
        project={{ id: uid(1), name: "alpha" }}
        onOpenChange={() => {}}
        onRename={() => {}}
        error={new ProjectInvalidInput({ field: "name", reason: "must match ^[a-z0-9][a-z0-9-]{0,63}$" })}
      />
    )
    const alertText = getByRole("alert").textContent ?? ""
    expect(alertText).toContain("invalid name:")
    expect(alertText).toContain("must match")
  })
})
