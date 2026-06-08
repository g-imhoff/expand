import { describe, expect, it } from "vitest"
import { isCommandPaletteHotkey } from "../../apps/desktop/src/renderer/features/command/model/hotkey"

const event = (
  over: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; code: string }>
) => ({ ctrlKey: false, metaKey: false, shiftKey: false, code: "KeyP", ...over })

describe("isCommandPaletteHotkey", () => {
  it("matches Ctrl+Shift+P", () => {
    expect(isCommandPaletteHotkey(event({ ctrlKey: true, shiftKey: true }))).toBe(true)
  })
  it("matches Cmd+Shift+P (macOS)", () => {
    expect(isCommandPaletteHotkey(event({ metaKey: true, shiftKey: true }))).toBe(true)
  })
  it("rejects Ctrl+P (no shift)", () => {
    expect(isCommandPaletteHotkey(event({ ctrlKey: true }))).toBe(false)
  })
  it("rejects Shift+P alone", () => {
    expect(isCommandPaletteHotkey(event({ shiftKey: true }))).toBe(false)
  })
  it("rejects Ctrl+Shift+K (wrong key)", () => {
    expect(isCommandPaletteHotkey(event({ ctrlKey: true, shiftKey: true, code: "KeyK" }))).toBe(false)
  })
})
