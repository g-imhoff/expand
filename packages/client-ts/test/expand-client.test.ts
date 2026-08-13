import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect, Layer, Stream } from "effect"
import { ProjectClient } from "../project/client"
import { ServerClient } from "../server/client"

const projectStub = Layer.succeed(ProjectClient, {
  create: ({ name }: { name: string; ensure: boolean }) =>
    Effect.succeed({ created: true, project: { id: "01J", name, createdAt: "t" } }),
  list: () => Effect.succeed([]),
  rename: () => Effect.die("unused"),
  changeDirectory: () => Effect.die("unused"),
  archive: () => Effect.die("unused"),
  restore: () => Effect.die("unused"),
  setMetadata: () => Effect.die("unused"),
  delete: () => Effect.die("unused"),
  events: () => Stream.empty
} as unknown as typeof ProjectClient["Service"])

const serverStub = Layer.succeed(ServerClient, {
  health: () => Effect.succeed("ok")
})

describe("client services", () => {
  it.effect("exposes project operations through ProjectClient", () =>
    Effect.flatMap(ProjectClient, (c) => c.create({ name: "alpha", ensure: true })).pipe(
      Effect.provide(projectStub),
      Effect.tap((created) => Effect.sync(() => expect(created.project.name).toBe("alpha")))
    ))

  it.effect("exposes server operations through ServerClient", () =>
    Effect.flatMap(ServerClient, (c) => c.health()).pipe(
      Effect.provide(serverStub),
      Effect.tap((health) => Effect.sync(() => expect(health).toBe("ok")))
    ))
})
