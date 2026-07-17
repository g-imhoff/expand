import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import React from "react"
import { render } from "ink-testing-library"
import { HintBar } from "@expand/ink-input/components/hint-bar-ink"
import type { Binding } from "@expand/ink-input/bindings"

const bindings: ReadonlyArray<Binding<null>> = [
  { keys: ["j", "down"], label: "next", action: null },
  { keys: ["r"], label: "rename", action: null }
]

describe("HintBar", () => {
  it.effect("renders 'firstKey label' pairs joined by separators", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => render(<HintBar bindings={bindings} />)),
      ({ lastFrame }) => Effect.sync(() => {
        expect(lastFrame()).toContain("j next")
        expect(lastFrame()).toContain("r rename")
        expect(lastFrame()).toContain("j next · r rename")
      }),
      (instance) => Effect.sync(() => instance.unmount())
    ))
})
