import { describe, expect, it } from "vitest"
import {
  emptyTextField, textField, textFieldConsumes, textFieldReduce
} from "@expand/ink-input/text-field"

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
  it("pasted literal key-name words are text, not key actions", () => {
    expect(textFieldConsumes("delete", "delete")).toBe(true)
    expect(textFieldConsumes("backspace", "backspace")).toBe(true)
    expect(textFieldConsumes("tab", "tab")).toBe(true)
    expect(textFieldReduce(textField("x"), "delete", "delete").value).toBe("xdelete")
    expect(textFieldReduce(textField("x"), "tab", "tab").value).toBe("xtab")
  })
  it("does not consume an unnamed empty key event", () => {
    expect(textFieldConsumes("", "")).toBe(false)
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
  it("backspace is code-point safe (no surrogate-pair corruption)", () => {
    expect(textFieldReduce(textField("a🎉"), "backspace", "").value).toBe("a")
    expect(textFieldReduce(textField("🎉"), "delete", "").value).toBe("")
  })
  it("ignores non-consumed keys", () => {
    expect(textFieldReduce(textField("ab"), "escape", "")).toEqual(textField("ab"))
    expect(textFieldReduce(textField("ab"), "up", "")).toEqual(textField("ab"))
  })
})
