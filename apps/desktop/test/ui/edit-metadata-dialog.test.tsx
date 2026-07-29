// @vitest-environment happy-dom
import { it } from "@effect/vitest"
import { fireEvent, screen } from "@testing-library/react"
import { Effect, Schema } from "effect"
import { describe, expect, vi } from "vitest"
import { Project as ProjectClass } from "@expand/contracts/project"
import { ProjectInvalidInput } from "@expand/contracts/rpc"
import {
  EditMetadataDialog,
  type EditMetadataDialogProps
} from "@expand/desktop/renderer/features/projects/components/EditMetadataDialog"
import { renderScoped } from "./_harness"

const uid = (n: number): string => "00000000-0000-4000-8000-" + String(n).padStart(12, "0")

const project = Schema.decodeUnknownSync(ProjectClass)({ id: uid(1), name: "alpha", directory: null, description: "old", tags: ["t1"], archived: false, createdAt: "t", updatedAt: "t" })

describe("EditMetadataDialog", () => {
  it.effect("submits parsed metadata and closes after callback success", () =>
    Effect.scoped(Effect.gen(function* () {
      const onOpenChange = vi.fn()
      const submit: EditMetadataDialogProps["onSubmit"] = (patch, options) => {
        expect(patch).toEqual({ description: "new", tags: ["a", "b"] })
        options.onSuccess()
      }
      const onSubmit = vi.fn(submit)
      yield* renderScoped(<EditMetadataDialog open project={project} onOpenChange={onOpenChange} onSubmit={onSubmit} />)
      fireEvent.change(screen.getByLabelText("description"), { target: { value: "new" } })
      fireEvent.change(screen.getByLabelText("tags"), { target: { value: "a, b ,a" } })
      fireEvent.click(screen.getByRole("button", { name: /save/i }))

      expect(onSubmit).toHaveBeenCalledOnce()
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })))

  it.effect("renders backend validation errors delivered through callback failure", () =>
    Effect.scoped(Effect.gen(function* () {
      const submit: EditMetadataDialogProps["onSubmit"] = (_patch, options) => {
        options.onError(new ProjectInvalidInput({ field: "tags", reason: "must match the tag pattern" }))
      }
      yield* renderScoped(<EditMetadataDialog open project={project} onOpenChange={() => {}} onSubmit={submit} />)
      fireEvent.click(screen.getByRole("button", { name: /save/i }))

      const alertText = screen.getByRole("alert").textContent ?? ""
      expect(alertText).toContain("invalid tags:")
      expect(alertText).toContain("must match")
    })))
})
