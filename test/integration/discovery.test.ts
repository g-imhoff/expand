import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Effect, Option } from "effect"
import { BunServices } from "@effect/platform-bun"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readEndpoint } from "@yodea/cli/discovery"
import { endpointFilePath, PROTOCOL_VERSION } from "@yodea/contracts/endpoint"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yodea-disc-"))
  process.env.YODEA_ENDPOINT_FILE = join(dir, "server.json")
})
afterEach(() => {
  delete process.env.YODEA_ENDPOINT_FILE
  rmSync(dir, { recursive: true, force: true })
})

const run = <A, E>(eff: Effect.Effect<A, E, BunServices.BunServices>) =>
  Effect.runPromise(Effect.provide(eff, BunServices.layer))

const writeEndpoint = (pid: number, protocolVersion = PROTOCOL_VERSION) =>
  writeFileSync(
    endpointFilePath(),
    JSON.stringify({ url: "ws://127.0.0.1:51789/rpc", token: "t", pid, protocolVersion })
  )

describe("readEndpoint", () => {
  it("returns None when the file is missing", async () => {
    expect(Option.isNone(await run(readEndpoint))).toBe(true)
  })
  it("returns Some for a live pid", async () => {
    writeEndpoint(process.pid) // self -> alive
    const r = await run(readEndpoint)
    expect(Option.isSome(r)).toBe(true)
  })
  it("returns None for a dead pid (stale file)", async () => {
    writeEndpoint(2147483647) // out-of-range pid -> ESRCH -> treated as dead
    expect(Option.isNone(await run(readEndpoint))).toBe(true)
  })
  it("returns None for a protocol-version mismatch", async () => {
    writeEndpoint(process.pid, PROTOCOL_VERSION + 1)
    expect(Option.isNone(await run(readEndpoint))).toBe(true)
  })
  it("returns None for malformed JSON", async () => {
    writeFileSync(endpointFilePath(), "{ not json")
    expect(Option.isNone(await run(readEndpoint))).toBe(true)
  })
})
