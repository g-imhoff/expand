import { describe, expect, it } from "vitest"
import {
  emptyTextField, textField, textFieldConsumes, textFieldReduce
} from "@yodea/ink-input/text-field"

describe("textFieldConsumes", () => {
  it("consumes printable input (keyName === input)", () => {
    expect(textFieldConsumes("a", "a")).toBe(true)
    expect(textFieldConsumes("A", "A")).toBe(true)
  })
  it("consumes multi-char paste, even when it spells a special-key name", () => {
    expect(textFieldConsumes("data", "data")).toBe(true)
    expect(textFieldConsumes("up", "up")).toBe(true) // pasted literal text "up"
  })
  it("consumes backspace and delete", () => {
    expect(textFieldConsumes("backspace", "")).toBe(true)
    expect(textFieldConsumes("delete", "")).toBe(true)
  })
  it("passes through return, escape, tab", () => {
    expect(textFieldConsumes("return", "")).toBe(false)
    expect(textFieldConsumes("escape", "")).toBe(false)
    expect(textFieldConsumes("tab", "")).toBe(false)
  })
  it("does not consume chords or navigation keys (empty input)", () => {
    expect(textFieldConsumes("ctrl+x", "x")).toBe(false)
    expect(textFieldConsumes("up", "")).toBe(false)
    expect(textFieldConsumes("down", "")).toBe(false)
  })
})

describe("textFieldReduce", () => {
  it("appends printable input (paste-safe: whole string)", () => {
    expect(textFieldReduce(emptyTextField, "d", "d").value).toBe("d")
    expect(textFieldReduce(textField("d"), "ata", "ata").value).toBe("data")
  })
  it("backspace and delete both remove the last character", () => {
    expect(textFieldReduce(textField("ab"), "backspace", "").value).toBe("a")
    expect(textFieldReduce(textField("ab"), "delete", "").value).toBe("a")
    expect(textFieldReduce(emptyTextField, "backspace", "").value).toBe("")
  })
  it("ignores non-consumed keys", () => {
    expect(textFieldReduce(textField("ab"), "escape", "")).toEqual(textField("ab"))
    expect(textFieldReduce(textField("ab"), "up", "")).toEqual(textField("ab"))
  })
})
