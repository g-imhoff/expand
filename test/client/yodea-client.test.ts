import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { YodeaClient } from "@yodea/client-core"

const stub = Layer.succeed(YodeaClient, {
  Health: () => Effect.succeed("ok"),
  ProjectCreate: ({ name }: { name: string; ensure: boolean }) =>
    Effect.succeed({ created: true, project: { id: "01J", name, createdAt: "t" } }),
  ProjectList: () => Effect.succeed([]),
  Connect: () => { throw new Error("unused") },
  Events: () => { throw new Error("unused") }
} as unknown as typeof YodeaClient["Service"])

describe("YodeaClient service", () => {
  it("is yieldable and exposes the RPC method surface", async () => {
    const health = await Effect.runPromise(
      Effect.flatMap(YodeaClient, (c) => c.Health()).pipe(Effect.provide(stub))
    )
    expect(health).toBe("ok")
  })
})
