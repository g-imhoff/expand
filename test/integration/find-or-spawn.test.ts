import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Effect } from "effect"
import { BunServices } from "@effect/platform-bun"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findOrSpawnBackend } from "@yodea/cli/discovery"
import { endpointFilePath, PROTOCOL_VERSION } from "@yodea/shared/endpoint"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yodea-spawn-"))
  process.env.YODEA_ENDPOINT_FILE = join(dir, "server.json")
})
afterEach(() => {
  delete process.env.YODEA_ENDPOINT_FILE
  rmSync(dir, { recursive: true, force: true })
})

describe("findOrSpawnBackend", () => {
  it("returns the existing live backend without spawning", async () => {
    writeFileSync(
      endpointFilePath(),
      JSON.stringify({
        url: "ws://127.0.0.1:51789/rpc",
        token: "t",
        pid: process.pid,
        protocolVersion: PROTOCOL_VERSION
      })
    )
    const endpoint = await Effect.runPromise(
      Effect.provide(findOrSpawnBackend({ port: 51789 }), BunServices.layer)
    )
    expect(endpoint.url).toBe("ws://127.0.0.1:51789/rpc")
    expect(endpoint.pid).toBe(process.pid)
  })
})
