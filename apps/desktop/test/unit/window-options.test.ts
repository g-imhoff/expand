import { describe, expect, it } from "vitest"
import { windowOptions } from "@expand/desktop/main/security/window-options"

describe("windowOptions (spec §10.2: webPreferences pin — every published Electron RCE chain starts here)", () => {
  it("pins sandbox, contextIsolation, nodeIntegration", () => {
    const options = windowOptions("/path/to/preload.cjs")
    expect(options.webPreferences.sandbox).toBe(true)
    expect(options.webPreferences.contextIsolation).toBe(true)
    expect(options.webPreferences.nodeIntegration).toBe(false)
    expect(options.webPreferences.preload).toBe("/path/to/preload.cjs")
  })
})
