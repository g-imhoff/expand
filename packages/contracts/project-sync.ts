import { Cause, Effect, Exit, Fiber, Option, Ref, Schedule, Stream } from "effect"
import type { SequencedEvent } from "@expand/contracts/events/domain"
import { Project } from "@expand/contracts/project"

export interface ProjectSnapshot {
  readonly projects: ReadonlyArray<Project>
  readonly seq: number
}

export interface ProjectSyncSource<E = never, R = never> {
  readonly status: Stream.Stream<ProjectSyncStatus, E, R>
  readonly list: () => Effect.Effect<ProjectSnapshot, E, R>
  readonly events: (
    payload: { readonly fromSeq: number }
  ) => Stream.Stream<SequencedEvent, E, R>
}

export interface ProjectSyncSink {
  readonly snapshot: (snapshot: ProjectSnapshot) => void
  readonly status: (status: ProjectSyncStatus) => void
}

export type ProjectSyncStatus =
  | "connected"
  | "reconnecting"
  | "disconnected"

export const runProjectSync = <E, R>(
  source: ProjectSyncSource<E, R>,
  sink: ProjectSyncSink
): Effect.Effect<never, E, R> =>
  Effect.scoped(
    Effect.gen(function* () {
      const active = yield* Ref.make(Option.none<Fiber.Fiber<void, never>>())
      const interruptActive = Ref.getAndSet(active, Option.none()).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (fiber) => Fiber.interrupt(fiber)
          })
        )
      )
      return yield* source.status.pipe(
        Stream.runForEach((status) =>
          Effect.gen(function* () {
            yield* Effect.sync(() => sink.status(status))
            yield* interruptActive
            if (status === "connected") {
              const fiber = yield* Effect.forkScoped(
                runEpochLoop(source, sink)
              )
              yield* Ref.set(active, Option.some(fiber))
            }
          })
        ),
        Effect.andThen(Effect.never)
      )
    })
  )

const epochRetryPolicy = Schedule.exponential("100 millis", 2).pipe(
  Schedule.either(Schedule.spaced("5 seconds"))
)

const epochEnded = Symbol("epoch ended")

const runEpochLoop = <E, R>(
  source: ProjectSyncSource<E, R>,
  sink: ProjectSyncSink
): Effect.Effect<never, never, R> =>
  Effect.gen(function* () {
    const recovering = yield* Ref.make(false)
    return yield* Ref.get(recovering).pipe(
      Effect.flatMap((recovered) => runEpoch(source, sink, recovered)),
      Effect.exit,
      Effect.flatMap((exit): Effect.Effect<never, E | typeof epochEnded> =>
        Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
          ? Effect.failCause(exit.cause)
          : Ref.set(recovering, true).pipe(
              Effect.andThen(Effect.sync(() => sink.status("reconnecting"))),
              Effect.andThen(Effect.fail(epochEnded))
            )
      ),
      Effect.retry(epochRetryPolicy),
      Effect.catch(() => Effect.never)
    )
  })

const runEpoch = <E, R>(
  source: ProjectSyncSource<E, R>,
  sink: ProjectSyncSink,
  recovered = false
): Effect.Effect<void, E, R> =>
  Effect.gen(function* () {
    const initial = yield* source.list()
    const current = yield* Ref.make(initial)
    yield* Effect.sync(() => sink.snapshot(initial))
    if (recovered) yield* Effect.sync(() => sink.status("connected"))
    yield* source.events({ fromSeq: initial.seq }).pipe(
      Stream.runForEach((sequenced) =>
        Ref.modify(current, (snapshot) => {
          if (sequenced.seq <= snapshot.seq) {
            return [Option.none<ProjectSnapshot>(), snapshot] as const
          }
          const next = {
            projects: Project.foldList(snapshot.projects, sequenced.event),
            seq: sequenced.seq
          }
          return [Option.some(next), next] as const
        }).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: (snapshot) => Effect.sync(() => sink.snapshot(snapshot))
            })
          )
        )
      )
    )
  })
