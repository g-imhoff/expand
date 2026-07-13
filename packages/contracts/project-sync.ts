import { Effect, Option, Ref, Stream } from "effect"
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
): Effect.Effect<never, never, R> =>
  Effect.scoped(
    source.status.pipe(
      Stream.runForEach((status) =>
        Effect.sync(() => sink.status(status)).pipe(
          Effect.andThen(
            status === "connected"
              ? Effect.forkScoped(
                  runEpoch(source, sink).pipe(Effect.catch(() => Effect.void))
                ).pipe(Effect.asVoid)
              : Effect.void
          )
        )
      ),
      Effect.catch(() => Effect.never),
      Effect.andThen(Effect.never)
    )
  )

const runEpoch = <E, R>(
  source: ProjectSyncSource<E, R>,
  sink: ProjectSyncSink
): Effect.Effect<void, E, R> =>
  Effect.gen(function* () {
    const initial = yield* source.list()
    const current = yield* Ref.make(initial)
    yield* Effect.sync(() => sink.snapshot(initial))
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
