import { describe, expect, it } from "vitest"
import { Deferred, Effect, Layer, PubSub, Stream, SubscriptionRef, Schema } from "effect"
import { ProjectCreated, ProjectRenamed } from "@expand/contracts/events/project"
import { Project as ProjectClass } from "@expand/contracts/project"
import type { Project } from "@expand/contracts/project"
import type { SequencedEvent } from "@expand/contracts/events/domain"
import { ProjectRpc, type ProjectRpcApi } from "@expand/desktop/renderer/rpc/project-rpc"
import { RendererProjectStore, RendererProjectStoreLayer } from "@expand/desktop/renderer/features/projects/data/project-store"

const uid = (n: number): string => "00000000-0000-4000-8000-" + String(n).padStart(12, "0")

// Polls a SubscriptionRef until `predicate` holds, instead of a fixed sleep that
// is fragile under CPU contention. Bounded so a never-converging condition fails
// loudly (with the last observed value) rather than hanging or sleeping blindly.
const pollUntil = <A>(
  ref: SubscriptionRef.SubscriptionRef<A>,
  predicate: (a: A) => boolean,
  describe: string
): Effect.Effect<A> =>
  Effect.gen(function* () {
    for (let i = 0; i < 200; i++) {
      const value = yield* SubscriptionRef.get(ref)
      if (predicate(value)) return value
      yield* Effect.sleep("5 millis")
    }
    const last = yield* SubscriptionRef.get(ref)
    return yield* Effect.die(new Error(`pollUntil never converged: ${describe}; last value: ${JSON.stringify(last)}`))
  })

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
      { seq: 1, event: ProjectCreated.make({ projectId: uid(1), name: "alpha", occurredAt: "t1" }) },
      { seq: 2, event: ProjectRenamed.make({ projectId: uid(1), name: "alpha-2", occurredAt: "t2" }) }
    ]
    const program = Effect.gen(function* () {
      const store = yield* RendererProjectStore
      // Poll until the forked subscriber has folded both events (Created + Renamed)
      // into the ref, rather than guessing how long that takes.
      return yield* pollUntil(
        store.projects,
        (ps) => ps.length === 1 && ps[0]!.name === "alpha-2",
        "stream folded into projects -> [alpha-2]"
      )
    }).pipe(Effect.scoped, Effect.provide(RendererProjectStoreLayer), Effect.provide(stubRpc([], events)))

    const result = await Effect.runPromise(program)
    expect(result.map((p) => p.name)).toEqual(["alpha-2"])
  })

  it("starts from the list snapshot before any event", async () => {
    const seed: ReadonlyArray<Project> = [
      Schema.decodeUnknownSync(ProjectClass)({ id: uid(10), name: "seed", directory: null, description: null, tags: [], archived: true, createdAt: "t", updatedAt: "t" })
    ]
    const program = Effect.gen(function* () {
      const store = yield* RendererProjectStore
      return yield* SubscriptionRef.get(store.projects)
    }).pipe(Effect.scoped, Effect.provide(RendererProjectStoreLayer), Effect.provide(stubRpc(seed, [])))
    const result = await Effect.runPromise(program)
    expect(result.map((p) => p.id)).toEqual([uid(10)])
  })
})

describe("RendererProjectStore — bootstrap window", () => {
  it("subscribes before list; window events are seq-gated (newer applied, stale skipped)", async () => {
    const program = Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<SequencedEvent>()
      const subscribed = yield* Deferred.make<void>()
      const seed: Project = Schema.decodeUnknownSync(ProjectClass)({
        id: uid(1), name: "v2", directory: null, description: null, tags: [],
        archived: false, createdAt: "t0", updatedAt: "t2"
      })
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
            yield* PubSub.publish(pubsub, { seq: 3, event: ProjectRenamed.make({ projectId: uid(1), name: "v3", occurredAt: "t3" }) })
            yield* PubSub.publish(pubsub, { seq: 1, event: ProjectRenamed.make({ projectId: uid(1), name: "v0", occurredAt: "t1" }) })
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
        // The stale seq:1 (v0) event is published after seq:3 (v3) and so is folded
        // after it (FIFO). Instead of sleeping to give v0 "a chance" to wrongly apply,
        // poll until v3 is stable across many consecutive reads: if the stale event
        // ever clobbered v3 this would observe the regression, and it converges
        // deterministically once v0 is drained-and-skipped.
        let stable = 0
        for (let i = 0; i < 200 && stable < 20; i++) {
          const ps = yield* SubscriptionRef.get(store.projects)
          stable = ps.length === 1 && ps[0]!.name === "v3" ? stable + 1 : 0
          yield* Effect.sleep("2 millis")
        }
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
