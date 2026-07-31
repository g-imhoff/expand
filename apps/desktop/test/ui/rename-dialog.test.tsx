// @vitest-environment happy-dom
import { it } from "@effect/vitest"
import { describe, expect, vi } from "vitest"
import { fireEvent } from "@testing-library/react"
import { Effect } from "effect"
import { ProjectInvalidInput } from "@expand/contracts/rpc"
import { RenameDialog } from "@expand/desktop/renderer/features/projects/components/RenameDialog"
import { renderScoped } from "./ui-harness"

const uid = (n: number): string => "00000000-0000-4000-8000-" + String(n).padStart(12, "0")

describe("RenameDialog", () => {
  it.effect("prefills the current name and submits the new name", () =>
    Effect.scoped(Effect.gen(function* () {
      const onRename = vi.fn()
      const { getByLabelText, getByText } = yield* renderScoped(
        <RenameDialog open project={{ id: uid(1), name: "alpha" }} onOpenChange={() => {}} onRename={onRename} />
      )
      const input = getByLabelText("new project name") as HTMLInputElement
      expect(input.value).toBe("alpha")
      fireEvent.change(input, { target: { value: "alpha-2" } })
      fireEvent.click(getByText("Rename"))
      expect(onRename).toHaveBeenCalledWith(uid(1), "alpha-2")
    })))

  it.effect("surfaces a rename error in a role=alert block and does not close itself on submit", () =>
    Effect.scoped(Effect.gen(function* () {
      const onOpenChange = vi.fn()
      const { getByRole } = yield* renderScoped(
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
    })))

  it.effect("renders a backend validation error (ProjectInvalidInput) in the alert", () =>
    Effect.scoped(Effect.gen(function* () {
      // Invalid input is now validated at the server's ingestion boundary and comes
      // back as a typed ProjectInvalidInput; describeError renders `invalid <field>: <reason>`.
      const { getByRole } = yield* renderScoped(
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
    })))
})
