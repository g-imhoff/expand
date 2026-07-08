import { describe, expect, it } from "vitest"
import { Effect, Exit, Layer, Stream, SubscriptionRef } from "effect"
import type { Project } from "@expand/contracts/project"
import type { SequencedEvent } from "@expand/contracts/events/domain"
import { ProjectCreated } from "@expand/contracts/events/project"
import { ProjectStore, type ConnectionStatus } from "@expand/client-ts"
import { connectionHandlers } from "@expand/desktop/main/rpc/connection-handlers"
import { healthHandlers } from "@expand/desktop/main/rpc/health-handlers"

const uid = (n: number): string => "00000000-0000-4000-8000-" + String(n).padStart(12, "0")

const connect = connectionHandlers.Connect as () => Stream.Stream<boolean, never, ProjectStore>
const events = connectionHandlers.Events as (
  payload: { readonly fromSeq?: number }
) => Stream.Stream<SequencedEvent, never, ProjectStore>
const health = healthHandlers.Health as () => Effect.Effect<string, never, ProjectStore>

const fakeStore = (
  status: SubscriptionRef.SubscriptionRef<ConnectionStatus>,
  events: Stream.Stream<SequencedEvent>
) =>
  Layer.succeed(ProjectStore, {
    projects: Effect.runSync(SubscriptionRef.make<ReadonlyArray<Project>>([])),
    status,
    events,
    snapshot: Effect.succeed({ projects: [], seq: 0 }),
    createProject: () => Effect.die("unused"),
    renameProject: () => Effect.die("unused"),
    changeDirectory: () => Effect.die("unused"),
    archiveProject: () => Effect.die("unused"),
    restoreProject: () => Effect.die("unused"),
    setMetadata: () => Effect.die("unused"),
    deleteProject: () => Effect.die("unused")
  })

const sequenced = (seq: number): SequencedEvent => ({
  seq,
  event: ProjectCreated.make({ projectId: uid(seq), name: "name-" + seq, occurredAt: "t" })
})

describe("desktop seam honesty", () => {
  it("Connect mirrors the upstream connection status instead of a hardcoded true", async () => {
    const program = Effect.gen(function* () {
      const status = yield* SubscriptionRef.make<ConnectionStatus>("reconnecting")
      const first = yield* Stream.runCollect(Stream.take(connect(), 1)).pipe(
        Effect.provide(fakeStore(status, Stream.empty))
      )
      yield* SubscriptionRef.set(status, "connected")
      const second = yield* Stream.runCollect(Stream.take(connect(), 1)).pipe(
        Effect.provide(fakeStore(status, Stream.empty))
      )
      return { first: Array.from(first), second: Array.from(second) }
    })
    const { first, second } = await Effect.runPromise(program)
    expect(first).toEqual([false])
    expect(second).toEqual([true])
  })

  it("Events forwards only entries with seq greater than fromSeq when provided", async () => {
    const entries = [sequenced(1), sequenced(2), sequenced(3)]
    const program = Effect.gen(function* () {
      const status = yield* SubscriptionRef.make<ConnectionStatus>("connected")
      const layer = fakeStore(status, Stream.fromIterable(entries))
      const all = yield* Stream.runCollect(events({})).pipe(Effect.provide(layer))
      const tail = yield* Stream.runCollect(events({ fromSeq: 2 })).pipe(Effect.provide(layer))
      return {
        all: Array.from(all).map((e) => e.seq),
        tail: Array.from(tail).map((e) => e.seq)
      }
    })
    const { all, tail } = await Effect.runPromise(program)
    expect(all).toEqual([1, 2, 3])
    expect(tail).toEqual([3])
  })

  it("Health answers ok only while connected and dies otherwise", async () => {
    const program = Effect.gen(function* () {
      const status = yield* SubscriptionRef.make<ConnectionStatus>("connected")
      const layer = fakeStore(status, Stream.empty)
      const ok = yield* health().pipe(Effect.provide(layer))
      yield* SubscriptionRef.set(status, "reconnecting")
      const exit = yield* Effect.exit(health().pipe(Effect.provide(layer)))
      return { ok, exit }
    })
    const { ok, exit } = await Effect.runPromise(program)
    expect(ok).toBe("ok")
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
