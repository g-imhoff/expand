import { describe, expect, it } from "vitest"
import { parseInput } from "@yodea/tui/commands/parse"

describe("parseInput", () => {
  it("classifies blank/whitespace as empty", () => {
    expect(parseInput("")).toEqual({ kind: "empty" })
    expect(parseInput("   ")).toEqual({ kind: "empty" })
  })
  it("classifies a slash line as a command with name + args", () => {
    expect(parseInput("/new alpha")).toEqual({ kind: "command", name: "new", args: ["alpha"] })
    expect(parseInput("  /open  my-id  ")).toEqual({ kind: "command", name: "open", args: ["my-id"] })
    expect(parseInput("/projects")).toEqual({ kind: "command", name: "projects", args: [] })
  })
  it("classifies non-slash text as a message", () => {
    expect(parseInput("hello there")).toEqual({ kind: "message", text: "hello there" })
  })
})
