import { describe, expect, it } from "vitest"
import type { KeyEvent } from "@expand/ink-input"
import { editTextField, textField } from "@expand/tui/input/text-field"

const event = (key: string, input: string, modifiers: Partial<KeyEvent> = {}): KeyEvent => ({ key, input, ctrl: false, meta: false, shift: false, ...modifiers })

describe("focused text editing", () => {
  it("inserts shifted literals and pasted control names", () => {
    expect(editTextField(textField(""), event("A", "A", { shift: true }))).toEqual({ value: "A", cursor: 1 })
    expect(editTextField(textField(""), event("return", "return"))).toEqual({ value: "return", cursor: 6 })
  })
  it("rejects control and meta chords", () => {
    expect(editTextField(textField("x"), event("d", "d", { ctrl: true }))).toBeNull()
    expect(editTextField(textField("x"), event("x", "x", { meta: true }))).toBeNull()
  })
  it("deletes complete code points", () => {
    expect(editTextField({ value: "a😀b", cursor: 2 }, event("backspace", ""))).toEqual({ value: "ab", cursor: 1 })
    expect(editTextField({ value: "a😀b", cursor: 1 }, event("delete", ""))).toEqual({ value: "ab", cursor: 1 })
  })
})
