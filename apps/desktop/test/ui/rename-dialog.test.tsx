// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest"
import { render, fireEvent } from "@testing-library/react"
import { Effect, Schema } from "effect"
import { ProjectId, ProjectName } from "@yodea/contracts/project"
import { RenameDialog } from "@yodea/desktop/renderer/features/projects/components/RenameDialog"

const uid = (n: number): string => "00000000-0000-4000-8000-" + String(n).padStart(12, "0")

describe("RenameDialog", () => {
  it("prefills the current name and submits the new name", () => {
    const onRename = vi.fn()
    const { getByLabelText, getByText } = render(
      <RenameDialog open project={{ id: ProjectId.make(uid(1)), name: "alpha" }} onOpenChange={() => {}} onRename={onRename} />
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
        project={{ id: ProjectId.make(uid(1)), name: "alpha" }}
        onOpenChange={onOpenChange}
        onRename={() => {}}
        error={{ _tag: "ProjectNameConflict", name: "alpha" }}
      />
    )
    expect(getByRole("alert").textContent).toContain("ProjectNameConflict")
    fireEvent.click(getByRole("button", { name: "Rename" }))
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it("renders the schema violation message when error is a SchemaError from ProjectName.makeEffect", async () => {
    // Produce a real SchemaError via ProjectName.makeEffect — "Bad Name!" violates the pattern rule.
    // The renderer store calls ProjectName.makeEffect before the RPC; on failure the error propagates
    // as the `error` prop of RenameDialog. We verify describeError renders the actual message.
    const schemaError = await Effect.runPromise(ProjectName.makeEffect("Bad Name!")).catch((e) => e)
    expect(Schema.isSchemaError(schemaError)).toBe(true)

    const { getByRole } = render(
      <RenameDialog
        open
        project={{ id: ProjectId.make(uid(1)), name: "alpha" }}
        onOpenChange={() => {}}
        onRename={() => {}}
        error={schemaError}
      />
    )
    const alertText = getByRole("alert").textContent ?? ""
    expect(alertText).toContain("invalid input:")
    expect(alertText).toContain("Expected a string matching")
  })
})
