import { afterEach, describe, expect, it } from "vitest"
import { join } from "node:path"
import { resolveAppContext } from "@yodea/contracts/app-context"

const ORIG = { ...process.env }
afterEach(() => {
  process.env = { ...ORIG }
})

describe("resolveAppContext", () => {
  it("exposes the channel and derives all subpaths under an explicit base", () => {
    const ctx = resolveAppContext("/tmp/x")
    expect(ctx.channel).toBe("dev")
    expect(ctx.paths).toEqual({
      dataDir: "/tmp/x",
      dbPath: join("/tmp/x", "events.db"),
      endpointFile: join("/tmp/x", "server.json"),
      logDir: join("/tmp/x", "logs")
    })
  })

  it("honors $XDG_DATA_HOME on linux and adds the dev suffix (channel=dev in tests)", () => {
    if (process.platform !== "linux") return
    process.env.XDG_DATA_HOME = "/home/u/.local/share"
    expect(resolveAppContext().paths.dataDir).toBe(join("/home/u/.local/share", "yodea-dev"))
  })
})
