import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { NodeServices } from "@effect/platform-node"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquireClient } from "../../rpc-client"
import { makeNodeAdapter } from "../../adapters/node"
import { AppContext, makeAppContext } from "@expand/contracts/app-context"

let dir: string
const nodeAdapter = makeNodeAdapter({
  backendCommand: [process.execPath, "--import", "tsx", join(process.cwd(), "apps/server/main.ts")]
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
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.provide(Layer.succeed(AppContext, makeAppContext(dir))))

    const { health, endpoint } = await Effect.runPromise(program)
    expect(health).toBe("ok")
    expect(endpoint.url.startsWith("ws://127.0.0.1:")).toBe(true)
    expect(endpoint.pid).toBeGreaterThan(0)
    expect(endpoint.token.length).toBeGreaterThan(0)
  })
})
