import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Effect, Layer, Option } from "effect"
import { ProcessServices } from "../process-services"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { readEndpoint } from "../../discovery"
import { PROTOCOL_VERSION } from "@expand/contracts/endpoint"
import { AppContext, makeAppContext } from "@expand/contracts/app-context"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "expand-disc-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const run = <A, E>(eff: Effect.Effect<A, E, TestContext.Services>) =>
  Effect.runPromise(Effect.provide(eff, Layer.mergeAll(ProcessServices.discoveryLayer, Layer.succeed(AppContext, makeTestAppContext(dir)))))

const writeEndpoint = (pid: number, protocolVersion = PROTOCOL_VERSION) =>
  writeFileSync(
    makeTestAppContext(dir).paths.endpointFile,
    JSON.stringify({ url: "ws://127.0.0.1:51789/rpc", token: "t", pid, protocolVersion })
  )

describe("readEndpoint", () => {
  it("returns None when the file is missing", async () => {
    expect(Option.isNone(await run(readEndpoint))).toBe(true)
  })
  it("returns Some for a live pid", async () => {
    writeEndpoint(ProcessServices.alivePid)
    const r = await run(readEndpoint)
    expect(Option.isSome(r)).toBe(true)
  })
  it("returns None for a dead pid (stale file)", async () => {
    writeEndpoint(2147483647)
    expect(Option.isNone(await run(readEndpoint))).toBe(true)
  })
  it("returns None for a protocol-version mismatch", async () => {
    writeEndpoint(ProcessServices.alivePid, PROTOCOL_VERSION + 1)
    expect(Option.isNone(await run(readEndpoint))).toBe(true)
  })
  it("returns None for malformed JSON", async () => {
    writeFileSync(makeTestAppContext(dir).paths.endpointFile, "{ not json")
    expect(Option.isNone(await run(readEndpoint))).toBe(true)
  })

  it("resolves a relative AppContext root from the supplied current directory", () => {
    expect(makeTestAppContext("state", "/work").paths.dataDir).toBe(resolve("/work", "state"))
  })
})

const makeTestAppContext = (dataDir: string, cwd = dataDir) =>
  makeAppContext(
    { join, resolve },
    { homeDir: cwd, cwd, dataDir }
  )

namespace TestContext {
  export type Services = ProcessServices | AppContext
}

function join(...paths: ReadonlyArray<string>): string {
  return resolve(...paths)
}
