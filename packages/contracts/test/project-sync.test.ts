import { describe, expect, it } from "vitest"
import { Deferred, Effect, Fiber, PubSub, Schema, Stream } from "effect"
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
    snapshot: (snapshot) => snapshots.push(snapshot),
    status: (status) => statuses.push(status)
  }
  return { sink, snapshots, statuses }
}

const statusStream = (status: PubSub.PubSub<ProjectSyncStatus>) =>
  Stream.make("connected" as ProjectSyncStatus).pipe(Stream.concat(Stream.fromPubSub(status)))

const runInitialSyncScenario = () =>
  Effect.runPromise(
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
  )

const runSequenceGateScenario = (sequences: ReadonlyArray<number>) =>
  Effect.runPromise(
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
  )

const runBootstrapReplayScenario = () =>
  Effect.runPromise(
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
  )

const runResnapshotScenario = () =>
  Effect.runPromise(
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
  )

const runUnexpectedEpochEndScenario = (kind: "failure" | "completion") =>
  Effect.runPromise(
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
  )

const runStatusFailureScenario = () => {
  const failure = new Error("status stream failed")
  const source: ProjectSyncSource<Error> = {
    status: Stream.fail(failure),
    list: () => Effect.die("unused"),
    events: () => Stream.die("unused")
  }
  return Effect.runPromise(
    Effect.flip(runProjectSync(source, makeRecorder().sink)).pipe(
      Effect.timeoutOrElse({
        duration: "100 millis",
        orElse: () => Effect.succeed(new Error("status failure was not propagated"))
      })
    )
  ).then((observed) => ({ failure, observed }))
}

const runSingleActiveEpochScenario = () =>
  Effect.runPromise(
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
  )

const runInterruptionScenario = () =>
  Effect.runPromise(
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
  )

describe("ProjectSync", () => {
  it("publishes the initial snapshot atomically", async () => {
    const result = await runInitialSyncScenario()
    expect(result.snapshots).toEqual([{ projects: [alpha], seq: 4 }])
    expect(result.eventRequests).toEqual([{ fromSeq: 4 }])
  })

  it("ignores duplicate and stale event sequences", async () => {
    const result = await runSequenceGateScenario([5, 5, 3, 6])
    expect(result.snapshots.map((snapshot) => snapshot.seq)).toEqual([4, 5, 6])
  })

  it("replays a mutation between list and event subscription", async () => {
    const result = await runBootstrapReplayScenario()
    expect(result.snapshot.projects.map((project) => project.name)).toEqual(["alpha-2"])
    expect(result.snapshot.seq).toBe(2)
  })

  it("retains state while reconnecting and replaces it after resnapshot", async () => {
    const result = await runResnapshotScenario()
    expect(result.atReconnect).toEqual({ projects: [alpha], seq: 1 })
    expect(result.afterReconnect).toEqual({ projects: [beta], seq: 5 })
  })

  it("restarts list and replay when Events fails without a status transition", async () => {
    const result = await runUnexpectedEpochEndScenario("failure")
    expect(result.statuses).toContain("reconnecting")
    expect(result.statuses.at(-1)).toBe("connected")
    expect(result.snapshots).toEqual([
      { projects: [alpha], seq: 1 },
      { projects: [beta], seq: 5 }
    ])
    expect(result.eventRequests).toEqual([{ fromSeq: 1 }, { fromSeq: 5 }])
  })

  it("restarts list and replay when Events completes without a status transition", async () => {
    const result = await runUnexpectedEpochEndScenario("completion")
    expect(result.statuses).toContain("reconnecting")
    expect(result.statuses.at(-1)).toBe("connected")
    expect(result.snapshots).toEqual([
      { projects: [alpha], seq: 1 },
      { projects: [beta], seq: 5 }
    ])
    expect(result.eventRequests).toEqual([{ fromSeq: 1 }, { fromSeq: 5 }])
  })

  it("propagates status stream failure to its owner", async () => {
    const result = await runStatusFailureScenario()
    expect(result.observed).toBe(result.failure)
  })

  it("interrupts the active epoch before reconnecting and resnapshotting", async () => {
    const result = await runSingleActiveEpochScenario()
    expect(result.duringReconnectOutcome).toBe("closed")
    expect(result.duringReconnect).toEqual({ projects: [alpha], seq: 1 })
    expect(result.afterResnapshot).toEqual({ projects: [beta], seq: 5 })
    expect(result.afterResnapshotOutcome).toBe("closed")
    expect(result.afterEpochOneDelivery).toEqual({ projects: [beta], seq: 5 })
  })

  it("interruption stops delivery", async () => {
    const result = await runInterruptionScenario()
    expect(result.afterInterrupt).toEqual(result.beforeInterrupt)
  })
})
