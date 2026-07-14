import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { NodeServices } from "@effect/platform-node"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { acquireClient } from "../../rpc-client"
import { makeNodeAdapter } from "../../adapters/node"
import { AppContext, makeAppContext } from "@expand/contracts/app-context"

let dir: string
const nodeAdapter = makeNodeAdapter({
  backendCommand: Effect.sync(() => ["node", "--import", "tsx", resolve("apps/server/main.ts")])
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "expand-acquire-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("acquireClient", () => {
  it("yields a ready client plus the advertised endpoint, and Health answers ok", async () => {
    const program = Effect.gen(function* () {
      const { client, endpoint } = yield* acquireClient(nodeAdapter)
      const health = yield* client.Health()
      return { health, endpoint }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.provide(Layer.succeed(AppContext, makeTestAppContext(dir))))

    const { health, endpoint } = await Effect.runPromise(program)
    expect(health).toBe("ok")
    expect(endpoint.url.startsWith("ws://127.0.0.1:")).toBe(true)
    expect(endpoint.pid).toBeGreaterThan(0)
    expect(endpoint.token.length).toBeGreaterThan(0)
  })
})

const makeTestAppContext = (dataDir: string) =>
  makeAppContext(
    { join, resolve },
    { homeDir: dataDir, cwd: dataDir, dataDir }
  )

function join(...paths: ReadonlyArray<string>): string {
  return resolve(...paths)
}
