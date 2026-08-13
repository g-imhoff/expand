// @vitest-environment happy-dom
import { it } from "@effect/vitest"
import { describe, expect, vi } from "vitest"
import { fireEvent } from "@testing-library/react"
import { Effect } from "effect"
import { ChangeDirectoryDialog } from "@expand/desktop/renderer/features/projects/components/ChangeDirectoryDialog"
import { renderScoped } from "./ui-harness"

const uid = (n: number): string => "00000000-0000-4000-8000-" + String(n).padStart(12, "0")

describe("ChangeDirectoryDialog", () => {
  it.effect("prefills the current directory and submits the new path", () =>
    Effect.scoped(Effect.gen(function* () {
      const onChangeDirectory = vi.fn()
      const changeDirectoryCalls: Array<{ id: string; directory: string }> = []
      const { getByLabelText, getByText } = yield* renderScoped(
        <ChangeDirectoryDialog
          open
          project={{ id: uid(1), name: "alpha", directory: "/old" }}
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
    })))

  it.effect("surfaces a directory error in a role=alert block", () =>
    Effect.scoped(Effect.gen(function* () {
      const { getByRole } = yield* renderScoped(
        <ChangeDirectoryDialog
          open
          project={{ id: uid(1), name: "alpha", directory: null }}
          onOpenChange={() => {}}
          onChangeDirectory={() => {}}
          error={{ _tag: "ProjectDirectoryInvalid", directory: "/bad", reason: "not-found" }}
        />
      )
      expect(getByRole("alert").textContent).toContain("ProjectDirectoryInvalid")
    })))
})
