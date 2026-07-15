import { it } from "@effect/vitest"
import { Deferred, Effect, Fiber, PubSub, Queue, Schema, Stream } from "effect"
import { describe, expect, expectTypeOf } from "vitest"
import type { SequencedEvent } from "@expand/contracts/events/domain"
import { ProjectRenamed } from "@expand/contracts/events/project"
import { Project } from "@expand/contracts/project"
import {
  runProjectSync,
  type ProjectSnapshot,
  type ProjectSyncSink,
  type ProjectSyncSource,
  type ProjectSyncStatus
} from "@expand/contracts/project-sync"

const alpha = Schema.decodeUnknownSync(Project)({
  id: "00000000-0000-4000-8000-000000000001",
  name: "alpha",
  directory: null,
  description: null,
  tags: [],
  archived: false,
  createdAt: "t1",
  updatedAt: "t1"
})

const beta = Schema.decodeUnknownSync(Project)({
  id: "00000000-0000-4000-8000-000000000002",
  name: "beta",
  directory: null,
  description: null,
  tags: [],
  archived: false,
  createdAt: "t5",
  updatedAt: "t5"
})

const renamed = (seq: number, project: Project, name: string): SequencedEvent => ({
  seq,
  event: ProjectRenamed.make({ projectId: project.id, name, occurredAt: `t${seq}` })
})

const waitUntil = (predicate: () => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (predicate()) return
      yield* Effect.sleep("5 millis")
    }
    return yield* Effect.die(new Error("scenario did not reach the expected state"))
  })

const makeRecorder = () => {
  const snapshots: Array<ProjectSnapshot> = []
  const statuses: Array<ProjectSyncStatus> = []
  const sink: ProjectSyncSink = {
    snapshot: (snapshot) => Effect.sync(() => {
      snapshots.push(snapshot)
    }),
    status: (status) => Effect.sync(() => {
      statuses.push(status)
    })
  }
  return { sink, snapshots, statuses }
}

const statusStream = (status: PubSub.PubSub<ProjectSyncStatus>) =>
  Stream.unwrap(
    PubSub.subscribe(status).pipe(
      Effect.map((subscription) =>
        Stream.make("connected" as ProjectSyncStatus).pipe(
          Stream.concat(Stream.fromSubscription(subscription))
        )
      )
    )
  )

const runInitialSyncScenario = () =>
  Effect.scoped(
    Effect.gen(function* () {
      const statuses = yield* PubSub.unbounded<ProjectSyncStatus>()
      const eventRequests: Array<{ readonly fromSeq: number }> = []
      const recorder = makeRecorder()
      const source: ProjectSyncSource = {
        status: statusStream(statuses),
        list: () => Effect.succeed({ projects: [alpha], seq: 4 }),
        events: (payload) => {
          eventRequests.push(payload)
          return Stream.never
        }
      }
      const fiber = yield* Effect.forkScoped(runProjectSync(source, recorder.sink))
      yield* waitUntil(() => eventRequests.length === 1)
      yield* Fiber.interrupt(fiber)
      return { snapshots: recorder.snapshots, eventRequests }
    })
  )

const runSequenceGateScenario = (sequences: ReadonlyArray<number>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const statuses = yield* PubSub.unbounded<ProjectSyncStatus>()
      const recorder = makeRecorder()
      const source: ProjectSyncSource = {
        status: statusStream(statuses),
        list: () => Effect.succeed({ projects: [alpha], seq: 4 }),
        events: () =>
          Stream.fromIterable(sequences.map((seq) => renamed(seq, alpha, `alpha-${seq}`))).pipe(
            Stream.concat(Stream.never)
          )
      }
      const fiber = yield* Effect.forkScoped(runProjectSync(source, recorder.sink))
      yield* waitUntil(() => recorder.snapshots.length === 3)
      yield* Fiber.interrupt(fiber)
      return { snapshots: recorder.snapshots }
    })
  )

const runBootstrapReplayScenario = () =>
  Effect.scoped(
    Effect.gen(function* () {
      const statuses = yield* PubSub.unbounded<ProjectSyncStatus>()
      const replay: Array<SequencedEvent> = []
      const recorder = makeRecorder()
      const source: ProjectSyncSource = {
        status: statusStream(statuses),
        list: () =>
          Effect.sync(() => {
            replay.push(renamed(2, alpha, "alpha-2"))
            return { projects: [alpha], seq: 1 }
          }),
        events: ({ fromSeq }) =>
          Stream.fromIterable(replay.filter((event) => event.seq > fromSeq)).pipe(
            Stream.concat(Stream.never)
          )
      }
      const fiber = yield* Effect.forkScoped(runProjectSync(source, recorder.sink))
      yield* waitUntil(() => recorder.snapshots.some((snapshot) => snapshot.seq === 2))
      yield* Fiber.interrupt(fiber)
      return { snapshot: recorder.snapshots.at(-1)! }
    })
  )

const runResnapshotScenario = () =>
  Effect.scoped(
    Effect.gen(function* () {
      const statuses = yield* PubSub.unbounded<ProjectSyncStatus>()
      const recorder = makeRecorder()
      let epoch = 0
      const source: ProjectSyncSource<Error> = {
        status: statusStream(statuses),
        list: () =>
          Effect.sync(() => {
            epoch += 1
            return epoch === 1
              ? { projects: [alpha], seq: 1 }
              : { projects: [beta], seq: 5 }
          }),
        events: () => epoch === 1 ? Stream.fail(new Error("epoch failed")) : Stream.never
      }
      const fiber = yield* Effect.forkScoped(runProjectSync(source, recorder.sink))
      yield* waitUntil(() => recorder.snapshots.length === 1)
      yield* PubSub.publish(statuses, "reconnecting")
      yield* waitUntil(() => recorder.statuses.includes("reconnecting"))
      const atReconnect = recorder.snapshots.at(-1)!
      yield* PubSub.publish(statuses, "connected")
      yield* waitUntil(() => recorder.snapshots.length === 2)
      const afterReconnect = recorder.snapshots.at(-1)!
      yield* Fiber.interrupt(fiber)
      return { atReconnect, afterReconnect }
    })
  )

const runUnexpectedEpochEndScenario = (kind: "failure" | "completion") =>
  Effect.scoped(
    Effect.gen(function* () {
      const statuses = yield* PubSub.unbounded<ProjectSyncStatus>()
      const recorder = makeRecorder()
      const eventRequests: Array<{ readonly fromSeq: number }> = []
      let epoch = 0
      const source: ProjectSyncSource<Error> = {
        status: statusStream(statuses),
        list: () =>
          Effect.sync(() => {
            epoch += 1
            return epoch === 1
              ? { projects: [alpha], seq: 1 }
              : { projects: [beta], seq: 5 }
          }),
        events: (payload) => {
          eventRequests.push(payload)
          return epoch === 1
            ? kind === "failure"
              ? Stream.fail(new Error("epoch failed"))
              : Stream.empty
            : Stream.never
        }
      }
      const fiber = yield* Effect.forkScoped(runProjectSync(source, recorder.sink))
      yield* waitUntil(() => recorder.snapshots.length === 2)
      yield* Fiber.interrupt(fiber)
      return {
        snapshots: recorder.snapshots,
        statuses: recorder.statuses,
        eventRequests
      }
    })
  )

const runStatusFailureScenario = () => {
  const failure = new Error("status stream failed")
  const source: ProjectSyncSource<Error> = {
    status: Stream.fail(failure),
    list: () => Effect.die("unused"),
    events: () => Stream.die("unused")
  }
  return Effect.flip(runProjectSync(source, makeRecorder().sink)).pipe(
    Effect.timeoutOrElse({
      duration: "100 millis",
      orElse: () => Effect.succeed(new Error("status failure was not propagated"))
    }),
    Effect.map((observed) => ({ failure, observed }))
  )
}

const runSingleActiveEpochScenario = () =>
  Effect.scoped(
    Effect.gen(function* () {
      const statuses = yield* PubSub.unbounded<ProjectSyncStatus>()
      const epochOneEvents = yield* PubSub.unbounded<SequencedEvent>()
      const epochOneSubscribed = yield* Deferred.make<void>()
      const epochOneClosed = yield* Deferred.make<void>()
      const recorder = makeRecorder()
      let epoch = 0
      const source: ProjectSyncSource = {
        status: statusStream(statuses),
        list: () =>
          Effect.sync(() => {
            epoch += 1
            return epoch === 1
              ? { projects: [alpha], seq: 1 }
              : { projects: [beta], seq: 5 }
          }),
        events: () =>
          epoch === 1
            ? Stream.unwrap(
                Effect.gen(function* () {
                  const subscription = yield* PubSub.subscribe(epochOneEvents)
                  yield* Deferred.succeed(epochOneSubscribed, undefined)
                  return Stream.fromSubscription(subscription)
                })
              ).pipe(Stream.ensuring(Deferred.succeed(epochOneClosed, undefined)))
            : Stream.never
      }
      const awaitDeliveryOrClose = (seq: number) =>
        Effect.race(
          Deferred.await(epochOneClosed).pipe(Effect.as("closed" as const)),
          waitUntil(() => recorder.snapshots.at(-1)?.seq === seq).pipe(
            Effect.as("delivered" as const)
          )
        )
      const fiber = yield* Effect.forkScoped(runProjectSync(source, recorder.sink))
      yield* Deferred.await(epochOneSubscribed)
      yield* PubSub.publish(statuses, "reconnecting")
      yield* PubSub.publish(statuses, "reconnecting")
      yield* waitUntil(
        () => recorder.statuses.filter((status) => status === "reconnecting").length === 2
      )
      yield* PubSub.publish(epochOneEvents, renamed(2, alpha, "alpha-during-reconnect"))
      const duringReconnectOutcome = yield* awaitDeliveryOrClose(2)
      const duringReconnect = recorder.snapshots.at(-1)!
      yield* PubSub.publish(statuses, "connected")
      yield* waitUntil(() => recorder.snapshots.some((snapshot) => snapshot.seq === 5))
      const afterResnapshot = recorder.snapshots.at(-1)!
      yield* PubSub.publish(epochOneEvents, renamed(6, alpha, "alpha-after-resnapshot"))
      const afterResnapshotOutcome = yield* awaitDeliveryOrClose(6)
      const afterEpochOneDelivery = recorder.snapshots.at(-1)!
      yield* Fiber.interrupt(fiber)
      return {
        duringReconnectOutcome,
        duringReconnect,
        afterResnapshot,
        afterResnapshotOutcome,
        afterEpochOneDelivery
      }
    })
  )

const runInterruptionScenario = () =>
  Effect.scoped(
    Effect.gen(function* () {
      const statuses = yield* PubSub.unbounded<ProjectSyncStatus>()
      const events = yield* PubSub.unbounded<SequencedEvent>()
      const recorder = makeRecorder()
      let subscribed = false
      const source: ProjectSyncSource<never> = {
        status: statusStream(statuses),
        list: () => Effect.succeed({ projects: [alpha], seq: 1 }),
        events: () =>
          Stream.unwrap(
            Effect.gen(function* () {
              const subscription = yield* PubSub.subscribe(events)
              subscribed = true
              return Stream.fromSubscription(subscription)
            })
          )
      }
      const fiber = yield* Effect.forkScoped(runProjectSync(source, recorder.sink))
      yield* waitUntil(() => subscribed)
      yield* PubSub.publish(events, renamed(2, alpha, "alpha-2"))
      yield* waitUntil(() => recorder.snapshots.some((snapshot) => snapshot.seq === 2))
      const beforeInterrupt = recorder.snapshots.slice()
      yield* Fiber.interrupt(fiber)
      yield* PubSub.publish(events, renamed(3, alpha, "alpha-3"))
      yield* Effect.sleep("20 millis")
      return { beforeInterrupt, afterInterrupt: recorder.snapshots.slice() }
    })
  )

const sinkFailureTimedOut = Symbol("sink failure timed out")

const observeProjectSyncFailure = <E, R>(effect: Effect.Effect<never, E, R>) =>
  Effect.flip(effect).pipe(
    Effect.timeoutOrElse({
      duration: "1 second",
      orElse: () => Effect.succeed(sinkFailureTimedOut)
    })
  )

interface SourceTypeError {
  readonly _tag: "SourceTypeError"
}

interface SinkTypeError {
  readonly _tag: "SinkTypeError"
}

interface SourceTypeEnvironment {
  readonly sourceTypeEnvironment: unique symbol
}

interface SinkTypeEnvironment {
  readonly sinkTypeEnvironment: unique symbol
}

describe("ProjectSync", () => {
  it("preserves independent source and sink error and environment types", () => {
    const source = null as unknown as ProjectSyncSource<SourceTypeError, SourceTypeEnvironment>
    const sink = null as unknown as ProjectSyncSink<SinkTypeError, SinkTypeEnvironment>

    expectTypeOf(runProjectSync(source, sink)).toEqualTypeOf<
      Effect.Effect<
        never,
        SourceTypeError | SinkTypeError,
        SourceTypeEnvironment | SinkTypeEnvironment
      >
    >()
  })

  it.live("propagates an initial snapshot sink failure without subscribing or retrying", () =>
    Effect.gen(function* () {
      const sinkError = { _tag: "InitialSnapshotSinkError" } as const
      const sourceError = { _tag: "UnusedSourceError" } as const
      let listCalls = 0
      let eventSubscriptions = 0
      const source: ProjectSyncSource<typeof sourceError> = {
        status: Stream.make("connected").pipe(Stream.concat(Stream.never)),
        list: () => Effect.sync(() => {
          listCalls += 1
          return { projects: [alpha], seq: 1 }
        }),
        events: () => {
          eventSubscriptions += 1
          return Stream.fail(sourceError)
        }
      }
      const sink: ProjectSyncSink<typeof sinkError> = {
        snapshot: () => Effect.fail(sinkError),
        status: () => Effect.void
      }

      const observed = yield* observeProjectSyncFailure(runProjectSync(source, sink))

      expect(observed).toBe(sinkError)
      expect(listCalls).toBe(1)
      expect(eventSubscriptions).toBe(0)
    }))

  it.live("propagates a recovery reconnecting sink failure without source retry", () =>
    Effect.gen(function* () {
      const sourceError = { _tag: "EventSourceError" } as const
      const sinkError = { _tag: "ReconnectingSinkError" } as const
      let listCalls = 0
      let eventSubscriptions = 0
      let reconnectingCalls = 0
      const source: ProjectSyncSource<typeof sourceError> = {
        status: Stream.make("connected").pipe(Stream.concat(Stream.never)),
        list: () => Effect.sync(() => {
          listCalls += 1
          return { projects: [alpha], seq: 1 }
        }),
        events: () => {
          eventSubscriptions += 1
          return Stream.fail(sourceError)
        }
      }
      const sink: ProjectSyncSink<typeof sinkError> = {
        snapshot: () => Effect.void,
        status: (status) => status === "reconnecting"
          ? Effect.sync(() => {
              reconnectingCalls += 1
            }).pipe(Effect.andThen(Effect.fail(sinkError)))
          : Effect.void
      }

      const observed = yield* observeProjectSyncFailure(runProjectSync(source, sink))

      expect(observed).toBe(sinkError)
      expect(listCalls).toBe(1)
      expect(eventSubscriptions).toBe(1)
      expect(reconnectingCalls).toBe(1)
    }))

  it.live("propagates an event snapshot sink failure without retrying", () =>
    Effect.gen(function* () {
      const sinkError = { _tag: "EventSnapshotSinkError" } as const
      let listCalls = 0
      let snapshotCalls = 0
      const source: ProjectSyncSource = {
        status: Stream.make("connected").pipe(Stream.concat(Stream.never)),
        list: () => Effect.sync(() => {
          listCalls += 1
          return { projects: [alpha], seq: 1 }
        }),
        events: () => Stream.make(renamed(2, alpha, "alpha-2")).pipe(Stream.concat(Stream.never))
      }
      const sink: ProjectSyncSink<typeof sinkError> = {
        snapshot: (snapshot) => Effect.sync(() => {
          snapshotCalls += 1
          return snapshot
        }).pipe(
          Effect.andThen(snapshot.seq === 2 ? Effect.fail(sinkError) : Effect.void)
        ),
        status: () => Effect.void
      }

      const observed = yield* observeProjectSyncFailure(runProjectSync(source, sink))

      expect(observed).toBe(sinkError)
      expect(listCalls).toBe(1)
      expect(snapshotCalls).toBe(2)
    }))

  it.live("propagates a recovered connected sink failure without another retry", () =>
    Effect.gen(function* () {
      const sourceError = { _tag: "FirstEpochSourceError" } as const
      const sinkError = { _tag: "RecoveredConnectedSinkError" } as const
      const snapshotSequences: Array<number> = []
      let listCalls = 0
      let connectedCalls = 0
      let reconnectingCalls = 0
      const source: ProjectSyncSource<typeof sourceError> = {
        status: Stream.make("connected").pipe(Stream.concat(Stream.never)),
        list: () => Effect.sync(() => {
          listCalls += 1
          return listCalls === 1
            ? { projects: [alpha], seq: 1 }
            : { projects: [beta], seq: 5 }
        }),
        events: () => listCalls === 1 ? Stream.fail(sourceError) : Stream.never
      }
      const sink: ProjectSyncSink<typeof sinkError> = {
        snapshot: (snapshot) => Effect.sync(() => {
          snapshotSequences.push(snapshot.seq)
        }),
        status: (status) => Effect.suspend(() => {
          if (status === "reconnecting") {
            reconnectingCalls += 1
            return Effect.void
          }
          if (status !== "connected") return Effect.void
          connectedCalls += 1
          return connectedCalls === 2 ? Effect.fail(sinkError) : Effect.void
        })
      }

      const observed = yield* observeProjectSyncFailure(runProjectSync(source, sink))

      expect(observed).toBe(sinkError)
      expect(listCalls).toBe(2)
      expect(snapshotSequences).toEqual([1, 5])
      expect(reconnectingCalls).toBe(1)
      expect(connectedCalls).toBe(2)
    }))

  it.live("interrupts a suspended event snapshot sink and closes the event stream", () =>
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<SequencedEvent>()
      const subscribed = yield* Queue.unbounded<void>()
      const eventStreamClosed = yield* Queue.unbounded<void>()
      const snapshotStarted = yield* Queue.unbounded<void>()
      const snapshotClosed = yield* Queue.unbounded<void>()
      const releaseSnapshot = yield* Queue.unbounded<void>()
      const delivered: Array<number> = []
      const source: ProjectSyncSource = {
        status: Stream.make("connected").pipe(Stream.concat(Stream.never)),
        list: () => Effect.succeed({ projects: [alpha], seq: 1 }),
        events: () => Stream.unwrap(
          Effect.gen(function* () {
            const subscription = yield* PubSub.subscribe(events)
            yield* Queue.offer(subscribed, undefined)
            return Stream.fromSubscription(subscription)
          })
        ).pipe(Stream.ensuring(Queue.offer(eventStreamClosed, undefined)))
      }
      const sink: ProjectSyncSink = {
        snapshot: (snapshot) => snapshot.seq === 1
          ? Effect.sync(() => {
              delivered.push(snapshot.seq)
            })
          : Effect.gen(function* () {
              yield* Queue.offer(snapshotStarted, undefined)
              yield* Queue.take(releaseSnapshot)
              delivered.push(snapshot.seq)
            }).pipe(Effect.ensuring(Queue.offer(snapshotClosed, undefined))),
        status: () => Effect.void
      }
      const fiber = yield* Effect.forkScoped(runProjectSync(source, sink))
      yield* Queue.take(subscribed)
      yield* PubSub.publish(events, renamed(2, alpha, "alpha-2"))
      yield* Queue.take(snapshotStarted)
      yield* Fiber.interrupt(fiber)
      yield* Queue.take(snapshotClosed)
      yield* Queue.take(eventStreamClosed)
      yield* Queue.offer(releaseSnapshot, undefined)
      yield* PubSub.publish(events, renamed(3, alpha, "alpha-3"))
      yield* Effect.sleep("20 millis")

      expect(delivered).toEqual([1])
    }).pipe(Effect.timeout("1 second")))

  it.live("publishes the initial snapshot atomically", () =>
    Effect.gen(function* () {
      const result = yield* runInitialSyncScenario()
      expect(result.snapshots).toEqual([{ projects: [alpha], seq: 4 }])
      expect(result.eventRequests).toEqual([{ fromSeq: 4 }])
    }))

  it.live("ignores duplicate and stale event sequences", () =>
    Effect.gen(function* () {
      const result = yield* runSequenceGateScenario([5, 5, 3, 6])
      expect(result.snapshots.map((snapshot) => snapshot.seq)).toEqual([4, 5, 6])
    }))

  it.live("replays a mutation between list and event subscription", () =>
    Effect.gen(function* () {
      const result = yield* runBootstrapReplayScenario()
      expect(result.snapshot.projects.map((project) => project.name)).toEqual(["alpha-2"])
      expect(result.snapshot.seq).toBe(2)
    }))

  it.live("retains state while reconnecting and replaces it after resnapshot", () =>
    Effect.gen(function* () {
      const result = yield* runResnapshotScenario()
      expect(result.atReconnect).toEqual({ projects: [alpha], seq: 1 })
      expect(result.afterReconnect).toEqual({ projects: [beta], seq: 5 })
    }))

  it.live("restarts list and replay when Events fails without a status transition", () =>
    Effect.gen(function* () {
      const result = yield* runUnexpectedEpochEndScenario("failure")
      expect(result.statuses).toContain("reconnecting")
      expect(result.statuses.at(-1)).toBe("connected")
      expect(result.snapshots).toEqual([
        { projects: [alpha], seq: 1 },
        { projects: [beta], seq: 5 }
      ])
      expect(result.eventRequests).toEqual([{ fromSeq: 1 }, { fromSeq: 5 }])
    }))

  it.live("restarts list and replay when Events completes without a status transition", () =>
    Effect.gen(function* () {
      const result = yield* runUnexpectedEpochEndScenario("completion")
      expect(result.statuses).toContain("reconnecting")
      expect(result.statuses.at(-1)).toBe("connected")
      expect(result.snapshots).toEqual([
        { projects: [alpha], seq: 1 },
        { projects: [beta], seq: 5 }
      ])
      expect(result.eventRequests).toEqual([{ fromSeq: 1 }, { fromSeq: 5 }])
    }))

  it.live("propagates status stream failure to its owner", () =>
    Effect.gen(function* () {
      const result = yield* runStatusFailureScenario()
      expect(result.observed).toBe(result.failure)
    }))

  it.live("interrupts the active epoch before reconnecting and resnapshotting", () =>
    Effect.gen(function* () {
      const result = yield* runSingleActiveEpochScenario()
      expect(result.duringReconnectOutcome).toBe("closed")
      expect(result.duringReconnect).toEqual({ projects: [alpha], seq: 1 })
      expect(result.afterResnapshot).toEqual({ projects: [beta], seq: 5 })
      expect(result.afterResnapshotOutcome).toBe("closed")
      expect(result.afterEpochOneDelivery).toEqual({ projects: [beta], seq: 5 })
    }))

  it.live("interruption stops delivery", () =>
    Effect.gen(function* () {
      const result = yield* runInterruptionScenario()
      expect(result.afterInterrupt).toEqual(result.beforeInterrupt)
    }))
})
