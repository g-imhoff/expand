import { describe, expect, it } from "vitest"
import { defineBindings } from "../index"
describe("defineBindings", () => {
  it("resolves modifier chords and owns hints", () => {
    const table = defineBindings([{ keys: ["j"], label: "next", action: "next" }, { keys: ["shift+ctrl+j"], label: "special", action: "special" }])
    expect(table.resolve({ key: "j", input: "j", ctrl: false, meta: false, shift: false })).toBe("next")
    expect(table.resolve({ key: "j", input: "j", ctrl: true, meta: false, shift: true })).toBe("special")
    expect(table.hints()).toEqual([{ key: "j", label: "next" }, { key: "ctrl+shift+j", label: "special" }])
  })
  it("rejects invalid and duplicate keys", () => {
    expect(() => defineBindings([{ keys: ["shift+ctrl+j"], label: "a", action: null }, { keys: ["ctrl+shift+j"], label: "b", action: null }])).toThrow()
    expect(() => defineBindings([{ keys: [], label: "empty", action: null }])).toThrow()
    expect(() => defineBindings([{ keys: ["data"], label: "paste", action: null }])).toThrow()
    expect(() => defineBindings([{ keys: [" "], label: "space", action: null }])).toThrow()
    expect(() => defineBindings([{ keys: ["ctrl+ "], label: "space", action: null }])).toThrow()
  })

  it("supports astral Unicode code points", () => {
    const table = defineBindings([{ keys: ["🎉"], label: "party", action: "party" }])
    expect(table.resolve({ key: "🎉", input: "🎉", ctrl: false, meta: false, shift: false })).toBe("party")
  })
})
