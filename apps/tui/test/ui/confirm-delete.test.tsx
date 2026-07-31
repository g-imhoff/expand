import { it } from "@effect/vitest"
import { describe, expect, vi } from "vitest"
import React from "react"
import { Effect, Exit, Scope } from "effect"
import { ConfirmDelete } from "@expand/tui/components/confirm-delete"
import { renderInkScoped } from "./runtime-harness"

describe("ConfirmDelete", () => {
  it.effect("does not release the Ink root again after explicit unmount", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const view = yield* renderInkScoped(<ConfirmDelete projectName="data" />).pipe(Scope.provide(scope))
      const unmount = vi.spyOn(view, "unmount")

      view.unmount()
      yield* view.unmounted
      yield* Scope.close(scope, Exit.void)

      expect(unmount).toHaveBeenCalledTimes(1)
    }))

  it.effect("renders the project name and the y/n hint", () =>
    Effect.scoped(Effect.gen(function* () {
      const view = yield* renderInkScoped(<ConfirmDelete projectName="data" />)
      expect(view.lastFrame()).toContain("delete “data”?")
      expect(view.lastFrame()).toContain("(y/n)")
    })))
})
