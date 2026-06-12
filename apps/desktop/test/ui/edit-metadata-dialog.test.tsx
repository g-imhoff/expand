// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { Project as ProjectClass, ProjectId, ProjectName, Tag } from "@yodea/contracts/project"
import { EditMetadataDialog } from "@yodea/desktop/renderer/features/projects/components/EditMetadataDialog"

const uid = (n: number): string => "00000000-0000-4000-8000-" + String(n).padStart(12, "0")

const project = ProjectClass.make({ id: ProjectId.make(uid(1)), name: ProjectName.make("alpha"), directory: null, description: "old", tags: [Tag.make("t1")], archived: false, createdAt: "t", updatedAt: "t" })

describe("EditMetadataDialog", () => {
  it("submits the edited description + parsed comma-separated tags", () => {
    const onSubmit = vi.fn().mockResolvedValue(project)
    render(<EditMetadataDialog open project={project} onOpenChange={() => {}} onSubmit={onSubmit} />)
    fireEvent.change(screen.getByLabelText("description"), { target: { value: "new" } })
    fireEvent.change(screen.getByLabelText("tags"), { target: { value: "a, b ,a" } })
    fireEvent.click(screen.getByRole("button", { name: /save/i }))
    expect(onSubmit).toHaveBeenCalledWith({ description: "new", tags: ["a", "b"] })
  })
})
