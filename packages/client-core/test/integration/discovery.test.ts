import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Effect, Layer, Option } from "effect"
import { BunServices } from "@effect/platform-bun"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readEndpoint } from "@yodea/client-core/discovery"
import { PROTOCOL_VERSION } from "@yodea/contracts/endpoint"
import { AppContext, appContextLayer, resolveAppContext } from "@yodea/contracts/app-context"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yodea-disc-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const run = <A, E>(eff: Effect.Effect<A, E, BunServices.BunServices | AppContext>) =>
  Effect.runPromise(Effect.provide(eff, Layer.mergeAll(BunServices.layer, appContextLayer(dir))))

const writeEndpoint = (pid: number, protocolVersion = PROTOCOL_VERSION) =>
  writeFileSync(
    resolveAppContext(dir).paths.endpointFile,
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
    writeFileSync(resolveAppContext(dir).paths.endpointFile, "{ not json")
    expect(Option.isNone(await run(readEndpoint))).toBe(true)
  })
})
