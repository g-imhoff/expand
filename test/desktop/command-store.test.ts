import { beforeEach, describe, expect, it } from "vitest"
import { useCommandPalette } from "../../apps/desktop/src/renderer/command/store"

describe("command palette store", () => {
  beforeEach(() => {
    useCommandPalette.setState({ open: false })
  })

  it("starts closed", () => {
    expect(useCommandPalette.getState().open).toBe(false)
  })

  it("setOpen sets the open flag", () => {
    useCommandPalette.getState().setOpen(true)
    expect(useCommandPalette.getState().open).toBe(true)
  })

  it("toggle flips the open flag", () => {
    useCommandPalette.getState().toggle()
    expect(useCommandPalette.getState().open).toBe(true)
    useCommandPalette.getState().toggle()
    expect(useCommandPalette.getState().open).toBe(false)
  })
})
