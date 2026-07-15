import { Effect, Fiber, FiberSet, Option, Ref, Schedule, Stream } from "effect"
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

export interface ProjectSyncSink<E = never, R = never> {
  readonly snapshot: (snapshot: ProjectSnapshot) => Effect.Effect<void, E, R>
  readonly status: (status: ProjectSyncStatus) => Effect.Effect<void, E, R>
}

export type ProjectSyncStatus =
  | "connected"
  | "reconnecting"
  | "disconnected"

export const runProjectSync = Effect.fn("ProjectSync.run")(
  <ES, RS, EK, RK>(
    source: ProjectSyncSource<ES, RS>,
    sink: ProjectSyncSink<EK, RK>
  ): Effect.Effect<never, ES | EK, RS | RK> =>
    Effect.scoped(
      Effect.gen(function* () {
        const active = yield* FiberSet.make<never, SourceFailure<ES> | SinkFailure<EK>>()
        const statusLoop = source.status.pipe(
          Stream.mapError(makeSourceFailure),
          Stream.runForEach((status) =>
            sink.status(status).pipe(
              Effect.mapError(makeSinkFailure),
              Effect.andThen(FiberSet.clear(active)),
              Effect.andThen(
                status === "connected"
                  ? FiberSet.run(active, runEpochLoop(source, sink)).pipe(Effect.asVoid)
                  : Effect.void
              )
            )
          ),
          Effect.andThen(Effect.never)
        )
        const epochFailure = FiberSet.join(active).pipe(
          Effect.andThen(Effect.never)
        )
        return yield* Effect.raceFirst(statusLoop, epochFailure)
      })
    ).pipe(
      Effect.mapError((failure) => failure.error)
    )
)

type SourceFailure<E> = {
  readonly _tag: "ProjectSyncSourceFailure"
  readonly error: E
}

type SinkFailure<E> = {
  readonly _tag: "ProjectSyncSinkFailure"
  readonly error: E
}

const epochRetryPolicy = Schedule.exponential("100 millis", 2).pipe(
  Schedule.either(Schedule.spaced("5 seconds"))
)

const epochEnded = Symbol("epoch ended")

const runEpochLoop = Effect.fn("ProjectSync.runEpochLoop")(
  <ES, RS, EK, RK>(
    source: ProjectSyncSource<ES, RS>,
    sink: ProjectSyncSink<EK, RK>
  ): Effect.Effect<never, SourceFailure<ES> | SinkFailure<EK>, RS | RK> =>
    Effect.gen(function* () {
      const epoch = yield* Effect.forkChild(
        Effect.gen(function* () {
          const recovering = yield* Ref.make(false)
          return yield* Ref.get(recovering).pipe(
            Effect.flatMap((recovered) => runEpoch(source, sink, recovered)),
            Effect.andThen(Effect.fail(epochEnded)),
            Effect.catchIf(isRetryableEpochFailure, (failure) =>
              Ref.set(recovering, true).pipe(
                Effect.andThen(
                  sink.status("reconnecting").pipe(
                    Effect.mapError(makeSinkFailure)
                  )
                ),
                Effect.andThen(Effect.fail(failure))
              )
            ),
            Effect.retry({
              schedule: epochRetryPolicy,
              while: isRetryableEpochFailure
            }),
            Effect.catchIf(
              (failure): failure is typeof epochEnded => failure === epochEnded,
              () => Effect.never
            )
          )
        })
      )
      return yield* Fiber.join(epoch)
    })
)

const runEpoch = Effect.fn("ProjectSync.runEpoch")(
  <ES, RS, EK, RK>(
    source: ProjectSyncSource<ES, RS>,
    sink: ProjectSyncSink<EK, RK>,
    recovered = false
  ): Effect.Effect<void, SourceFailure<ES> | SinkFailure<EK>, RS | RK> =>
    Effect.gen(function* () {
      const initial = yield* source.list().pipe(
        Effect.mapError(makeSourceFailure)
      )
      const current = yield* Ref.make(initial)
      yield* sink.snapshot(initial).pipe(
        Effect.mapError(makeSinkFailure)
      )
      if (recovered) {
        yield* sink.status("connected").pipe(
          Effect.mapError(makeSinkFailure)
        )
      }
      yield* source.events({ fromSeq: initial.seq }).pipe(
        Stream.mapError(makeSourceFailure),
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
                onSome: (snapshot) => sink.snapshot(snapshot).pipe(
                  Effect.mapError(makeSinkFailure)
                )
              })
            )
          )
        )
      )
    })
)

const makeSourceFailure = <E>(error: E): SourceFailure<E> => ({
  _tag: "ProjectSyncSourceFailure",
  error
})

const makeSinkFailure = <E>(error: E): SinkFailure<E> => ({
  _tag: "ProjectSyncSinkFailure",
  error
})

const isRetryableEpochFailure = <E>(
  failure: SourceFailure<E> | SinkFailure<unknown> | typeof epochEnded
): failure is SourceFailure<E> | typeof epochEnded =>
  failure === epochEnded || failure._tag === "ProjectSyncSourceFailure"
