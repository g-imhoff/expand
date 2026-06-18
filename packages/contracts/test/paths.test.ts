import { afterEach, describe, expect, it } from "vitest"
import { join } from "node:path"
import { resolvePaths } from "@yodea/contracts/paths"

const ORIG = { ...process.env }
afterEach(() => {
  process.env = { ...ORIG }
})

describe("resolvePaths", () => {
  it("derives all subpaths under an explicit base (used by --data-dir + tests)", () => {
    const p = resolvePaths("/tmp/x")
    expect(p).toEqual({
      dataDir: "/tmp/x",
      dbPath: join("/tmp/x", "events.db"),
      endpointFile: join("/tmp/x", "server.json"),
      logDir: join("/tmp/x", "logs")
    })
  })

  it("honors $XDG_DATA_HOME on linux and adds the dev suffix (channel=dev in tests)", () => {
    if (process.platform !== "linux") return
    process.env.XDG_DATA_HOME = "/home/u/.local/share"
    expect(resolvePaths().dataDir).toBe(join("/home/u/.local/share", "yodea-dev"))
  })
})
