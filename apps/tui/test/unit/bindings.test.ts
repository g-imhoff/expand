import { describe, expect, it } from "vitest"
import {
  confirmDeleteBindings, createBindings, listBindings, metadataBindings,
  textOverlayBindings
} from "@yodea/tui/input/bindings"

const allTables = [
  ["list", listBindings], ["create", createBindings],
  ["textOverlay", textOverlayBindings], ["metadata", metadataBindings],
  ["confirmDelete", confirmDeleteBindings]
] as const

describe("binding tables", () => {
  it("no key appears twice within a table (no ambiguity by construction)", () => {
    for (const [name, table] of allTables) {
      const keys = table.flatMap((b) => b.keys)
      expect(new Set(keys).size, `duplicate key in ${name} table`).toBe(keys.length)
    }
  })
  it("list commands are single keys or named specials — never chords", () => {
    for (const b of listBindings) {
      for (const key of b.keys) expect(key).not.toContain("+")
    }
  })
  it("text-context tables bind nothing printable (text gets first refusal)", () => {
    const printable = (k: string) => k.length === 1
    for (const b of [...createBindings, ...textOverlayBindings, ...metadataBindings]) {
      for (const key of b.keys) expect(printable(key), `printable key ${key} bound in a text context`).toBe(false)
    }
  })
})
