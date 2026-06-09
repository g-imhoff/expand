import { describe, expect, it } from "vitest"
import { Effect, Layer, Stream, SubscriptionRef } from "effect"
import { ProjectCreated, ProjectRenamed } from "@yodea/contracts/events/project"
import type { DomainEvent } from "@yodea/contracts/events/domain"
import type { Project } from "@yodea/contracts/project"
import { ProjectRpc, type ProjectRpcApi } from "@yodea/desktop/renderer/rpc/project-rpc"
import { RendererProjectStore, RendererProjectStoreLayer } from "@yodea/desktop/renderer/features/projects/data/project-store"

const stubRpc = (initial: ReadonlyArray<Project>, events: ReadonlyArray<DomainEvent>): Layer.Layer<ProjectRpc> =>
  Layer.succeed(ProjectRpc, {
    create: () => Effect.die("unused"),
    rename: () => Effect.die("unused"),
    changeDirectory: () => Effect.die("unused"),
    archive: () => Effect.die("unused"),
    restore: () => Effect.die("unused"),
    setMetadata: () => Effect.die("unused"),
    delete: () => Effect.die("unused"),
    list: () => Effect.succeed(initial),
    events: () => Stream.fromIterable(events)
  } satisfies ProjectRpcApi)

describe("RendererProjectStore", () => {
  it("seeds from list and folds the event stream into the SubscriptionRef", async () => {
    const events: ReadonlyArray<DomainEvent> = [
      ProjectCreated.make({ projectId: "a", name: "alpha", occurredAt: "t1" }),
      ProjectRenamed.make({ projectId: "a", name: "alpha-2", occurredAt: "t2" })
    ]
    const program = Effect.gen(function* () {
      const store = yield* RendererProjectStore
      yield* Effect.sleep("20 millis") // let the forked subscriber consume the finite stream
      return yield* SubscriptionRef.get(store.projects)
    }).pipe(Effect.scoped, Effect.provide(RendererProjectStoreLayer), Effect.provide(stubRpc([], events)))

    const result = await Effect.runPromise(program)
    expect(result.map((p) => p.name)).toEqual(["alpha-2"])
  })

  it("starts from the list snapshot before any event", async () => {
    const seed: ReadonlyArray<Project> = [
      { id: "x", name: "seed", directory: null, description: null, tags: [], archived: true, createdAt: "t", updatedAt: "t" }
    ]
    const program = Effect.gen(function* () {
      const store = yield* RendererProjectStore
      return yield* SubscriptionRef.get(store.projects)
    }).pipe(Effect.scoped, Effect.provide(RendererProjectStoreLayer), Effect.provide(stubRpc(seed, [])))
    const result = await Effect.runPromise(program)
    expect(result.map((p) => p.id)).toEqual(["x"])
  })
})
