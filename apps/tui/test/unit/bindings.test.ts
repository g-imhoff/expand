import { describe, expect, it } from "vitest"
import {
  confirmDeleteBindings, createBindings, listBindings, metadataBindings,
  textOverlayBindings
} from "@expand/tui/input/bindings"

const allTables = [
  ["list", listBindings], ["create", createBindings],
  ["textOverlay", textOverlayBindings], ["metadata", metadataBindings],
  ["confirmDelete", confirmDeleteBindings]
] as const

describe("binding tables", () => {
  it("no key appears twice within a table (no ambiguity by construction)", () => {
    for (const [name, table] of allTables) {
      const keys = table.hints().map((hint) => hint.key)
      expect(new Set(keys).size, `duplicate key in ${name} table`).toBe(keys.length)
    }
  })
  it("list commands are single keys or named specials — never chords", () => {
    for (const key of listBindings.hints().map((hint) => hint.key)) expect(key).not.toContain("+")
  })
  it("text-context tables bind nothing printable (text gets first refusal)", () => {
    const printable = (k: string) => k.length === 1
    for (const key of [...createBindings.hints(), ...textOverlayBindings.hints(), ...metadataBindings.hints()].map((hint) => hint.key)) expect(printable(key), `printable key ${key} bound in a text context`).toBe(false)
  })
})
