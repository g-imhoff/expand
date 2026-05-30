import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Effect, Exit, FileSystem, Scope } from "effect"
import { BunServices } from "@effect/platform-bun"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeEndpointFile } from "@yodea/server/endpoint-file"
import { endpointFilePath, PROTOCOL_VERSION } from "@yodea/contracts/endpoint"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yodea-ep-"))
  process.env.YODEA_ENDPOINT_FILE = join(dir, "server.json")
})
afterEach(() => {
  delete process.env.YODEA_ENDPOINT_FILE
  rmSync(dir, { recursive: true, force: true })
})

describe("endpoint file (I-3)", () => {
  it("writes the file inside the scope and removes it when the scope closes", async () => {
    const file = endpointFilePath()
    const program = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const scope = yield* Scope.make()
      yield* Effect.provideService(
        writeEndpointFile({
          url: "ws://127.0.0.1:51789/rpc",
          token: "tok",
          pid: 4242,
          protocolVersion: PROTOCOL_VERSION
        }),
        Scope.Scope,
        scope
      )
      const during = yield* fs.exists(file)
      yield* Scope.close(scope, Exit.void)
      const after = yield* fs.exists(file)
      return { during, after }
    }).pipe(Effect.provide(BunServices.layer))

    const r = await Effect.runPromise(program)
    expect(r.during).toBe(true)
    expect(r.after).toBe(false)
  })
})
