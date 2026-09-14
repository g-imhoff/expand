import { describe, expect, it } from "vitest"
import {
  formatIncarnation,
  incarnationsMatch,
  parseProcStatStarttime
} from "../process-incarnation"

const statLine = (comm: string, starttime: string): string =>
  `1234 (${comm}) R 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 ${starttime} 100 0`

describe("parseProcStatStarttime", () => {
  it("reads field 22 from a normal stat line", () => {
    expect(parseProcStatStarttime(statLine("node", "987654"))).toBe("987654")
  })

  it("handles a command name with spaces and parentheses", () => {
    expect(parseProcStatStarttime(statLine("my (tricky) proc", "42"))).toBe("42")
  })

  it("returns undefined without a closing paren", () => {
    expect(parseProcStatStarttime("1234 R 1 2 3")).toBeUndefined()
  })

  it("returns undefined for a truncated stat line", () => {
    expect(parseProcStatStarttime("1234 (node) R 1 2")).toBeUndefined()
  })

  it("returns undefined for a non-numeric starttime", () => {
    expect(parseProcStatStarttime(statLine("node", "soon"))).toBeUndefined()
  })
})

describe("formatIncarnation", () => {
  it("scopes the starttime to the boot id", () => {
    expect(formatIncarnation("987654", "boot-id")).toBe("boot-id:987654")
  })

  it("still identifies the process when the boot id is missing", () => {
    expect(formatIncarnation("987654", undefined)).toBe("nobootid:987654")
  })

  it("returns undefined without a starttime", () => {
    expect(formatIncarnation(undefined, "boot-id")).toBeUndefined()
  })
})

describe("incarnationsMatch", () => {
  it("requires both sides to be present and equal", () => {
    expect(incarnationsMatch("a:1", "a:1")).toBe(true)
    expect(incarnationsMatch("a:1", "a:2")).toBe(false)
    expect(incarnationsMatch(undefined, "a:1")).toBe(false)
    expect(incarnationsMatch("a:1", undefined)).toBe(false)
    expect(incarnationsMatch(undefined, undefined)).toBe(false)
  })
})
