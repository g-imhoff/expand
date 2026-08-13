import { describe, expect, it } from "vitest"
import desktopManifest from "../../package.json"
import desktopConfig, { makeElectronConfig } from "../../electron.vite.config"

describe("desktop build version", () => {
  it("defines the release channel and one quoted version for every Electron target", () => {
    const config = makeElectronConfig("1.2.3", "release")
    const definitions = {
      __EXPAND_CHANNEL__: '"release"',
      __EXPAND_VERSION__: '"1.2.3"'
    }
    expect(config.main?.define).toEqual(definitions)
    expect(config.preload?.define).toEqual(definitions)
    expect(config.renderer?.define).toEqual(definitions)
  })

  it("isolates development and production channels", () => {
    const development = desktopConfig({ command: "serve", mode: "development" })
    const production = desktopConfig({ command: "build", mode: "production" })

    expect(development.main?.define?.__EXPAND_CHANNEL__).toBe('"dev"')
    expect(production.main?.define?.__EXPAND_CHANNEL__).toBe('"release"')
  })

  it("bundles application dependencies and externalizes the packaged WebSocket runtime", () => {
    const config = makeElectronConfig("1.2.3", "release")
    const external = config.main?.build?.rollupOptions?.external
    expect(external).toContain("electron")
    expect(external).not.toContain("effect")
    expect(external).toContain("ws")
    expect(config.main?.plugins).toBeUndefined()
  })

  it("disables packaged Node mode", () => {
    expect(desktopManifest.build.electronFuses.runAsNode).toBe(false)
  })

})
