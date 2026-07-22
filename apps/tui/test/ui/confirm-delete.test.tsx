import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import React from "react"
import { Effect } from "effect"
import { ConfirmDelete } from "@expand/tui/components/confirm-delete"
import { renderInkScoped } from "./_runtime-harness"

describe("ConfirmDelete", () => {
  it.effect("renders the project name and the y/n hint", () =>
    Effect.scoped(Effect.gen(function* () {
      const view = yield* renderInkScoped(<ConfirmDelete projectName="data" />)
      expect(view.lastFrame()).toContain("delete “data”?")
      expect(view.lastFrame()).toContain("(y/n)")
    })))
})
