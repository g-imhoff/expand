// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { Effect, Schema } from "effect"
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

  it("renders invalid input: prefix when onSubmit rejects with a SchemaError from Tag.makeEffect", async () => {
    // Produce a real SchemaError — "BAD TAG" violates the /^[a-z0-9][a-z0-9-]{0,63}$/ pattern rule.
    const schemaError = await Effect.runPromise(Tag.makeEffect("BAD TAG")).catch((e) => e)
    expect(Schema.isSchemaError(schemaError)).toBe(true)

    const onSubmit = vi.fn().mockRejectedValue(schemaError)
    render(<EditMetadataDialog open project={project} onOpenChange={() => {}} onSubmit={onSubmit} />)
    fireEvent.click(screen.getByRole("button", { name: /save/i }))

    await waitFor(() => {
      const alertText = screen.getByRole("alert").textContent ?? ""
      expect(alertText).toContain("invalid input:")
      expect(alertText).toContain("Expected a string matching")
    })
  })
})
