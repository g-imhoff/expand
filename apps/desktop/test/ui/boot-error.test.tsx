// @vitest-environment happy-dom
import { it } from "@effect/vitest"
import { describe, expect, vi } from "vitest"
import { fireEvent } from "@testing-library/react"
import { Effect } from "effect"
import { BootError } from "@expand/desktop/renderer/app/BootError"
import { renderScoped } from "./ui-harness"

describe("BootError", () => {
  it.effect("renders the failure in a role=alert block with a Retry button", () =>
    Effect.scoped(Effect.gen(function* () {
      const onRetry = vi.fn()
      const { getByRole } = yield* renderScoped(<BootError message="boot timed out" onRetry={onRetry} />)
      expect(getByRole("alert").textContent).toContain("boot timed out")
      fireEvent.click(getByRole("button", { name: "Retry" }))
      expect(onRetry).toHaveBeenCalledTimes(1)
    })))
})
