import { describe, expect, it } from "vitest"
import { Deferred, Effect, Layer, PubSub, Stream, SubscriptionRef } from "effect"
import { ProjectCreated, ProjectRenamed } from "@yodea/contracts/events/project"
import type { SequencedEvent } from "@yodea/contracts/events/domain"
import type { Project } from "@yodea/contracts/project"
import { ProjectRpc, type ProjectRpcApi } from "@yodea/desktop/renderer/rpc/project-rpc"
import { RendererProjectStore, RendererProjectStoreLayer } from "@yodea/desktop/renderer/features/projects/data/project-store"

const stubRpc = (initial: ReadonlyArray<Project>, events: ReadonlyArray<SequencedEvent>): Layer.Layer<ProjectRpc> =>
  Layer.succeed(ProjectRpc, {
    create: () => Effect.die("unused"),
    rename: () => Effect.die("unused"),
    changeDirectory: () => Effect.die("unused"),
    archive: () => Effect.die("unused"),
    restore: () => Effect.die("unused"),
    setMetadata: () => Effect.die("unused"),
    delete: () => Effect.die("unused"),
    list: () => Effect.succeed({ projects: initial, seq: 0 }),
    events: () => Stream.fromIterable(events)
  } satisfies ProjectRpcApi)

describe("RendererProjectStore", () => {
  it("seeds from list and folds the event stream into the SubscriptionRef", async () => {
    const events: ReadonlyArray<SequencedEvent> = [
      { seq: 1, event: ProjectCreated.make({ projectId: "a", name: "alpha", occurredAt: "t1" }) },
      { seq: 2, event: ProjectRenamed.make({ projectId: "a", name: "alpha-2", occurredAt: "t2" }) }
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

describe("RendererProjectStore — bootstrap window", () => {
  it("subscribes before list; window events are seq-gated (newer applied, stale skipped)", async () => {
    const program = Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<SequencedEvent>()
      const subscribed = yield* Deferred.make<void>()
      const seed: Project = {
        id: "a", name: "v2", directory: null, description: null, tags: [],
        archived: false, createdAt: "t0", updatedAt: "t2"
      }
      const rpcLayer = Layer.succeed(ProjectRpc, {
        create: () => Effect.die("unused"),
        rename: () => Effect.die("unused"),
        changeDirectory: () => Effect.die("unused"),
        archive: () => Effect.die("unused"),
        restore: () => Effect.die("unused"),
        setMetadata: () => Effect.die("unused"),
        delete: () => Effect.die("unused"),
        list: () =>
          Effect.gen(function* () {
            yield* Deferred.await(subscribed)
            yield* PubSub.publish(pubsub, { seq: 3, event: ProjectRenamed.make({ projectId: "a", name: "v3", occurredAt: "t3" }) })
            yield* PubSub.publish(pubsub, { seq: 1, event: ProjectRenamed.make({ projectId: "a", name: "v0", occurredAt: "t1" }) })
            return { projects: [seed], seq: 2 }
          }),
        events: () =>
          Stream.unwrap(
            Effect.gen(function* () {
              const sub = yield* PubSub.subscribe(pubsub)
              yield* Deferred.succeed(subscribed, undefined)
              return Stream.fromSubscription(sub)
            })
          )
      } satisfies ProjectRpcApi)

      return yield* Effect.gen(function* () {
        const store = yield* RendererProjectStore
        yield* SubscriptionRef.changes(store.projects).pipe(
          Stream.filter((ps) => ps.some((p) => p.name === "v3")),
          Stream.take(1),
          Stream.runDrain
        )
        yield* Effect.sleep("50 millis")
        return yield* SubscriptionRef.get(store.projects)
      }).pipe(
        Effect.provide(RendererProjectStoreLayer),
        Effect.provide(rpcLayer),
        Effect.timeoutOrElse({
          duration: "5 seconds",
          orElse: () => Effect.fail(new Error("v3 never applied — the bootstrap window lost the event"))
        })
      )
    }).pipe(Effect.scoped)

    const result = await Effect.runPromise(program)
    expect(result.map((p) => p.name)).toEqual(["v3"])
  })
})
