import { describe, expect, it } from "vitest"
import { fileURLToPath } from "node:url"
import { resolveBackendCommand } from "../../index"

// A file that definitely exists and looks runnable: this very test module.
const realSource = fileURLToPath(import.meta.url)
// A path that does not exist on disk.
const missingSource = fileURLToPath(new URL("./does-not-exist.ts", import.meta.url))

describe("resolveBackendCommand", () => {
  describe("EXPAND_BACKEND_CMD override", () => {
    it("parses a JSON string array and returns it verbatim (wins over defaults)", () => {
      const cmd = resolveBackendCommand({
        env: { EXPAND_BACKEND_CMD: '["my-server","--flag"]' },
        sourceEntry: realSource,
        binaryArgs: ["ignored"]
      })
      expect(cmd).toEqual(["my-server", "--flag"])
    })

    it("throws a clear error on malformed JSON (fallback)", () => {
      expect(() => resolveBackendCommand({ env: { EXPAND_BACKEND_CMD: "not json" } })).toThrow(
        "EXPAND_BACKEND_CMD must be a JSON array of strings"
      )
    })

    it("throws when the JSON is not an array of strings", () => {
      expect(() => resolveBackendCommand({ env: { EXPAND_BACKEND_CMD: '["ok", 3]' } })).toThrow(
        "EXPAND_BACKEND_CMD must be a JSON array of strings"
      )
      expect(() => resolveBackendCommand({ env: { EXPAND_BACKEND_CMD: '{"cmd":"x"}' } })).toThrow(
        "EXPAND_BACKEND_CMD must be a JSON array of strings"
      )
    })

    it("ignores an empty override and falls through to the default", () => {
      const cmd = resolveBackendCommand({ env: { EXPAND_BACKEND_CMD: "" }, binaryArgs: ["fallback"] })
      expect(cmd).toEqual(["fallback"])
    })
  })

  describe("source-vs-compiled default derivation", () => {
    it("uses source mode when the entry exists and looks runnable", () => {
      const cmd = resolveBackendCommand({ env: {}, sourceEntry: realSource, binaryArgs: ["compiled"] })
      expect(cmd).toEqual([process.execPath, realSource])
    })

    it("appends sourceArgs after the source entry", () => {
      const cmd = resolveBackendCommand({ env: {}, sourceEntry: realSource, sourceArgs: ["server"] })
      expect(cmd).toEqual([process.execPath, realSource, "server"])
    })

    it("uses an explicit execPath for the source-mode command (e.g. Electron's bun)", () => {
      const cmd = resolveBackendCommand({ env: {}, execPath: "bun", sourceEntry: realSource, sourceArgs: ["server"] })
      expect(cmd).toEqual(["bun", realSource, "server"])
    })

    it("falls back to binaryArgs when the source entry does not exist", () => {
      const cmd = resolveBackendCommand({ env: {}, sourceEntry: missingSource, binaryArgs: ["expand-server"] })
      expect(cmd).toEqual(["expand-server"])
    })

    it("falls back to binaryArgs when no sourceEntry is given", () => {
      const cmd = resolveBackendCommand({ env: {}, binaryArgs: ["bun", "/abs/apps/server/main.ts"] })
      expect(cmd).toEqual(["bun", "/abs/apps/server/main.ts"])
    })

    it("throws when nothing resolves a command", () => {
      expect(() => resolveBackendCommand({ env: {} })).toThrow("no backend command configured")
      expect(() => resolveBackendCommand({ env: {}, sourceEntry: missingSource })).toThrow(
        "no backend command configured"
      )
    })
  })
})
