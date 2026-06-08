import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { ProjectClient, ServerClient } from "@yodea/client-core"

const projectStub = Layer.succeed(ProjectClient, {
  create: ({ name }: { name: string; ensure: boolean }) =>
    Effect.succeed({ created: true, project: { id: "01J", name, createdAt: "t" } }),
  list: () => Effect.succeed([]),
  rename: () => Effect.die("unused"),
  changeDirectory: () => Effect.die("unused"),
  archive: () => Effect.die("unused"),
  restore: () => Effect.die("unused"),
  setMetadata: () => Effect.die("unused"),
  delete: () => Effect.die("unused")
} as unknown as typeof ProjectClient["Service"])

const serverStub = Layer.succeed(ServerClient, {
  health: () => Effect.succeed("ok")
})

describe("client services", () => {
  it("exposes project operations through ProjectClient", async () => {
    const created = await Effect.runPromise(
      Effect.flatMap(ProjectClient, (c) => c.create({ name: "alpha", ensure: true })).pipe(Effect.provide(projectStub))
    )
    expect(created.project.name).toBe("alpha")
  })

  it("exposes server operations through ServerClient", async () => {
    const health = await Effect.runPromise(
      Effect.flatMap(ServerClient, (c) => c.health()).pipe(Effect.provide(serverStub))
    )
    expect(health).toBe("ok")
  })
})
