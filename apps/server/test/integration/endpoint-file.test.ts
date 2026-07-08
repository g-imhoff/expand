import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Effect, Exit, FileSystem, Scope } from "effect"
import { BunServices } from "@effect/platform-bun"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeEndpointFile } from "@expand/server/endpoint-file"
import { PROTOCOL_VERSION } from "@expand/contracts/endpoint"
import { makeTestAppContext } from "@expand/contracts/app-context.testkit"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "expand-ep-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("endpoint file (I-3)", () => {
  it("writes the file inside the scope and removes it when the scope closes", async () => {
    const file = makeTestAppContext(dir).paths.endpointFile
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
    }).pipe(Effect.provide(BunServices.layer), Effect.provide(makeTestAppContext(dir).layer))

    const r = await Effect.runPromise(program)
    expect(r.during).toBe(true)
    expect(r.after).toBe(false)
  })
})
