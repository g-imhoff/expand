import { describe, expect, it } from "vitest"
import { toKeyName, type InkKey } from "@yodea/ink-input/key-name"

const noKeys: InkKey = {
  upArrow: false, downArrow: false, leftArrow: false, rightArrow: false,
  return: false, escape: false, tab: false, backspace: false, delete: false,
  ctrl: false, meta: false, shift: false, pageUp: false, pageDown: false
}
const k = (overrides: Partial<InkKey>): InkKey => ({ ...noKeys, ...overrides })

describe("toKeyName", () => {
  it("maps special keys to canonical names", () => {
    expect(toKeyName("", k({ upArrow: true }))).toBe("up")
    expect(toKeyName("", k({ downArrow: true }))).toBe("down")
    expect(toKeyName("", k({ leftArrow: true }))).toBe("left")
    expect(toKeyName("", k({ rightArrow: true }))).toBe("right")
    expect(toKeyName("", k({ return: true }))).toBe("return")
    expect(toKeyName("", k({ escape: true }))).toBe("escape")
    expect(toKeyName("", k({ tab: true }))).toBe("tab")
    expect(toKeyName("", k({ backspace: true }))).toBe("backspace")
    expect(toKeyName("", k({ delete: true }))).toBe("delete")
  })

  it("special-key flags win over any input residue", () => {
    // terminals can put residue in input alongside flags; flags are authoritative
    expect(toKeyName("", k({ backspace: true }))).toBe("backspace")
    expect(toKeyName("[A", k({ upArrow: true }))).toBe("up")
  })

  it("maps ctrl/meta chords", () => {
    expect(toKeyName("x", k({ ctrl: true }))).toBe("ctrl+x")
    expect(toKeyName("C", k({ ctrl: true }))).toBe("ctrl+c")
    expect(toKeyName("k", k({ meta: true }))).toBe("meta+k")
  })

  it("passes printable input through verbatim (case preserved)", () => {
    expect(toKeyName("a", noKeys)).toBe("a")
    expect(toKeyName("A", k({ shift: true }))).toBe("A")
  })

  it("passes multi-char input (paste) through verbatim", () => {
    expect(toKeyName("data", noKeys)).toBe("data")
  })
})
