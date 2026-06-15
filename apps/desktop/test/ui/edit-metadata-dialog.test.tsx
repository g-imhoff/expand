// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { Schema } from "effect"
import { Project as ProjectClass } from "@yodea/contracts/project"
import { ProjectInvalidInput } from "@yodea/contracts/rpc"
import { EditMetadataDialog } from "@yodea/desktop/renderer/features/projects/components/EditMetadataDialog"

const uid = (n: number): string => "00000000-0000-4000-8000-" + String(n).padStart(12, "0")

const project = Schema.decodeUnknownSync(ProjectClass)({ id: uid(1), name: "alpha", directory: null, description: "old", tags: ["t1"], archived: false, createdAt: "t", updatedAt: "t" })

describe("EditMetadataDialog", () => {
  it("submits the edited description + parsed comma-separated tags", () => {
    const onSubmit = vi.fn().mockResolvedValue(project)
    render(<EditMetadataDialog open project={project} onOpenChange={() => {}} onSubmit={onSubmit} />)
    fireEvent.change(screen.getByLabelText("description"), { target: { value: "new" } })
    fireEvent.change(screen.getByLabelText("tags"), { target: { value: "a, b ,a" } })
    fireEvent.click(screen.getByRole("button", { name: /save/i }))
    expect(onSubmit).toHaveBeenCalledWith({ description: "new", tags: ["a", "b"] })
  })

  it("renders a backend validation error (ProjectInvalidInput) when onSubmit rejects", async () => {
    // Invalid tags are validated at the server's ingestion boundary and come back
    // as a typed ProjectInvalidInput; describeError renders `invalid <field>: <reason>`.
    const onSubmit = vi.fn().mockRejectedValue(new ProjectInvalidInput({ field: "tags", reason: "must match the tag pattern" }))
    render(<EditMetadataDialog open project={project} onOpenChange={() => {}} onSubmit={onSubmit} />)
    fireEvent.click(screen.getByRole("button", { name: /save/i }))

    await waitFor(() => {
      const alertText = screen.getByRole("alert").textContent ?? ""
      expect(alertText).toContain("invalid tags:")
      expect(alertText).toContain("must match")
    })
  })
})
