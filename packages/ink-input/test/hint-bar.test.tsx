import { describe, expect, it } from "vitest"
import React from "react"
import { render } from "ink-testing-library"
import { HintBar } from "@yodea/ink-input/components/hint-bar-ink"
import type { Binding } from "@yodea/ink-input/bindings"

const bindings: ReadonlyArray<Binding<null>> = [
  { keys: ["j", "down"], label: "next", action: null },
  { keys: ["r"], label: "rename", action: null }
]

describe("HintBar", () => {
  it("renders 'firstKey label' pairs joined by separators", () => {
    const { lastFrame } = render(<HintBar bindings={bindings} />)
    expect(lastFrame()).toContain("j next")
    expect(lastFrame()).toContain("r rename")
    expect(lastFrame()).toContain("j next · r rename")
  })
})
