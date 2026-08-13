// @vitest-environment happy-dom
import { it } from "@effect/vitest"
import { describe, expect, vi } from "vitest"
import { screen, fireEvent } from "@testing-library/react"
import { Effect } from "effect"
import { DeleteProjectDialog } from "@expand/desktop/renderer/features/projects/components/DeleteProjectDialog"
import { renderScoped } from "./ui-harness"

describe("DeleteProjectDialog", () => {
  it.effect("shows the project name and calls onConfirm when Delete is clicked", () =>
    Effect.scoped(Effect.gen(function* () {
      const onConfirm = vi.fn()
      yield* renderScoped(
        <DeleteProjectDialog
          open
          projectName="alpha"
          pending={false}
          onOpenChange={() => {}}
          onConfirm={onConfirm}
        />
      )
      expect(screen.getByText(/alpha/)).toBeTruthy()
      fireEvent.click(screen.getByRole("button", { name: /^delete$/i }))
      expect(onConfirm).toHaveBeenCalledTimes(1)
    })))

  it.effect("calls onOpenChange(false) when Cancel is clicked", () =>
    Effect.scoped(Effect.gen(function* () {
      const onOpenChange = vi.fn()
      yield* renderScoped(
        <DeleteProjectDialog open projectName="alpha" pending={false} onOpenChange={onOpenChange} onConfirm={() => {}} />
      )
      fireEvent.click(screen.getByRole("button", { name: /cancel/i }))
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })))

  it.effect("surfaces a delete error in a role=alert block", () =>
    Effect.scoped(Effect.gen(function* () {
      yield* renderScoped(
        <DeleteProjectDialog
          open
          projectName="alpha"
          pending={false}
          onOpenChange={() => {}}
          onConfirm={() => {}}
          error={{ _tag: "ProjectNotFound", id: "a" }}
        />
      )
      expect(screen.getByRole("alert").textContent).toContain("ProjectNotFound")
    })))
})
