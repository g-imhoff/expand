import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Effect } from "effect"
import { BunServices } from "@effect/platform-bun"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquireClient } from "@expand/client-core/rpc-client"
import { bunAdapter } from "@expand/client-core/adapters/bun"
import { makeTestAppContext } from "@expand/contracts/app-context.testkit"

let dir: string
let bunMainBefore: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "expand-acquire-"))
  bunMainBefore = (Bun as unknown as { main: string }).main
  ;(Bun as unknown as { main: string }).main = join(process.cwd(), "apps/server/main.ts")
})
afterEach(() => {
  ;(Bun as unknown as { main: string }).main = bunMainBefore
  rmSync(dir, { recursive: true, force: true })
})

describe("acquireClient", () => {
  it("yields a ready client plus the advertised endpoint, and Health answers ok", async () => {
    const program = Effect.gen(function* () {
      const { client, endpoint } = yield* acquireClient(bunAdapter)
      const health = yield* client.Health()
      return { health, endpoint }
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.provide(makeTestAppContext(dir).layer))

    const { health, endpoint } = await Effect.runPromise(program)
    expect(health).toBe("ok")
    expect(endpoint.url.startsWith("ws://127.0.0.1:")).toBe(true)
    expect(endpoint.pid).toBeGreaterThan(0)
    expect(endpoint.token.length).toBeGreaterThan(0)
  })
})
