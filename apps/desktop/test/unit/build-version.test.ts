import { describe, expect, it } from "vitest"
import { makeElectronConfig } from "../../electron.vite.config"

describe("desktop build version", () => {
  it("defines one quoted version for every Electron target", () => {
    const config = makeElectronConfig("1.2.3")
    expect(config.main?.define).toEqual({ __EXPAND_VERSION__: '"1.2.3"' })
    expect(config.preload?.define).toEqual({ __EXPAND_VERSION__: '"1.2.3"' })
    expect(config.renderer?.define).toEqual({ __EXPAND_VERSION__: '"1.2.3"' })
  })
})
