import { describe, expect, it } from "vitest"
import { commandBarReducer, initialCommandBarState } from "@yodea/tui/hooks/use-command-bar"

describe("commandBarReducer", () => {
  it("inserts text (preserving newlines) and recomputes suggestions for slash input", () => {
    const s1 = commandBarReducer(initialCommandBarState, { type: "insert", text: "/pro" })
    expect(s1.buffer).toBe("/pro")
    expect(s1.suggestions.map((c) => c.name)).toEqual(["projects"])
    const s2 = commandBarReducer(initialCommandBarState, { type: "insert", text: "a\nb" })
    expect(s2.buffer).toBe("a\nb")
    expect(s2.suggestions).toEqual([])
  })
  it("backspace removes the last character", () => {
    const typed = commandBarReducer(initialCommandBarState, { type: "insert", text: "abc" })
    expect(commandBarReducer(typed, { type: "backspace" }).buffer).toBe("ab")
  })
  it("newline appends a line break", () => {
    const typed = commandBarReducer(initialCommandBarState, { type: "insert", text: "a" })
    expect(commandBarReducer(typed, { type: "newline" }).buffer).toBe("a\n")
  })
  it("commit pushes the trimmed buffer to history and clears", () => {
    const typed = commandBarReducer(initialCommandBarState, { type: "insert", text: "hello" })
    const committed = commandBarReducer(typed, { type: "commit" })
    expect(committed.buffer).toBe("")
    expect(committed.history).toEqual(["hello"])
  })
  it("history prev/next walks committed entries then returns to empty", () => {
    let s = initialCommandBarState
    s = commandBarReducer(commandBarReducer(s, { type: "insert", text: "one" }), { type: "commit" })
    s = commandBarReducer(commandBarReducer(s, { type: "insert", text: "two" }), { type: "commit" })
    s = commandBarReducer(s, { type: "historyPrev" }) // -> "two"
    expect(s.buffer).toBe("two")
    s = commandBarReducer(s, { type: "historyPrev" }) // -> "one"
    expect(s.buffer).toBe("one")
    s = commandBarReducer(s, { type: "historyNext" }) // -> "two"
    expect(s.buffer).toBe("two")
    s = commandBarReducer(s, { type: "historyNext" }) // -> past end -> ""
    expect(s.buffer).toBe("")
  })
  it("reset clears the buffer without recording history", () => {
    const typed = commandBarReducer(initialCommandBarState, { type: "insert", text: "draft" })
    const reset = commandBarReducer(typed, { type: "reset" })
    expect(reset.buffer).toBe("")
    expect(reset.history).toEqual([])
  })
})
