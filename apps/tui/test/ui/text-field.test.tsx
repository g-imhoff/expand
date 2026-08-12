import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import React from "react"
import { Effect } from "effect"
import { textField } from "@expand/tui/input/text-field"
import { TextField } from "@expand/tui/components/text-field"
import { renderInkScoped } from "./runtime-harness"

describe("TextField", () => {
  it.effect("renders label and value", () =>
    Effect.scoped(Effect.gen(function* () {
      const view = yield* renderInkScoped(<TextField label="rename ▸ " state={textField("data")} focused={false} />)
      expect(view.lastFrame()).toContain("rename ▸")
      expect(view.lastFrame()).toContain("data")
    })))

  it.effect("shows a cursor glyph only when focused", () =>
    Effect.scoped(Effect.gen(function* () {
      const focused = yield* renderInkScoped(<TextField label="new ▸ " state={textField("x")} focused={true} />)
      expect(focused.lastFrame()).toContain("▍")
      const blurred = yield* renderInkScoped(<TextField label="new ▸ " state={textField("x")} focused={false} />)
      expect(blurred.lastFrame()).not.toContain("▍")
    })))
})
