import { describe, expect, it } from "vitest"
import { resolveBinding, type Binding } from "@expand/ink-input/bindings"

const table: ReadonlyArray<Binding<string>> = [
  { keys: ["j", "down"], label: "next", action: "next" },
  { keys: ["x", "delete"], label: "delete", action: "del" }
]

describe("resolveBinding", () => {
  it("resolves any of a binding's keys to its action", () => {
    expect(resolveBinding(table, "j")).toBe("next")
    expect(resolveBinding(table, "down")).toBe("next")
    expect(resolveBinding(table, "delete")).toBe("del")
  })
  it("returns null for unbound keys", () => {
    expect(resolveBinding(table, "q")).toBeNull()
    expect(resolveBinding(table, "J")).toBeNull() // case-sensitive: "J" ≠ "j"
  })
  it("first match wins", () => {
    const overlap: ReadonlyArray<Binding<string>> = [
      { keys: ["a"], label: "first", action: "first" },
      { keys: ["a"], label: "second", action: "second" }
    ]
    expect(resolveBinding(overlap, "a")).toBe("first")
  })
})
