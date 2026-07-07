import { Context, Duration, Effect, Exit, Layer, Schema, Stream, SubscriptionRef } from "effect"
import { Project } from "@yodea/contracts/project"
import { FOLD_VERSIONS } from "@yodea/contracts/fold-version.generated"
import type { SequencedEvent } from "@yodea/contracts/events/domain"
import { ProjectEventStore } from "@yodea/server/application/projects/project-event-store"
import { ProjectionStateStore } from "@yodea/server/db/projection-state-store"

export const PROJECTION_NAME = "projects"

export const CHECKPOINT_DEBOUNCE_MS = 500

const ProjectsFromJson = Schema.fromJsonString(Schema.Array(Project))

export class ProjectProjection extends Context.Service<ProjectProjection, {
  readonly list: Effect.Effect<ReadonlyArray<Project>>
  readonly snapshot: Effect.Effect<State>
  // Advance the in-memory read model with a freshly committed event. Idempotent:
  // an event whose seq is not ahead of the current state is a no-op. Returns true
  // iff it was applied. Called by the single writer inside commit().
  readonly apply: (sequenced: SequencedEvent) => Effect.Effect<boolean>
}>()("yodea/ProjectProjection", {
  make: Effect.gen(function* () {
    const events = yield* ProjectEventStore
    const states = yield* ProjectionStateStore

    // ---- boot catch-up: runs once at layer build; single non-concurrent writer ----
    // projection_state is a DISPOSABLE cache (spec §3.3): a save failure is
    // non-fatal (warn, continue — next boot just folds a longer tail). The event
    // LOG is the source of truth, so a log-read failure is a hard defect (orDie —
    // and scan itself dies on an undecodable row, D10 fail-fast).
    const saveCheckpoint = (s: State) =>
      Schema.encodeEffect(ProjectsFromJson)(s.projects).pipe(
        Effect.orDie,
        Effect.flatMap((state) =>
          states.save(PROJECTION_NAME, { state, lastSeq: s.seq, foldVersion: FOLD_VERSIONS.projects })
        ),
        Effect.catch((e) =>
          Effect.logWarning(`projection checkpoint save failed — continuing (next boot folds a longer tail): ${e}`)
        )
      )

    // Load failure for ANY reason (absent / SQL error) → fall back to a
    // from-zero rebuild rather than failing to boot.
    const loaded = yield* states.load(PROJECTION_NAME).pipe(
      Effect.catch((e) =>
        Effect.logWarning(`projection state load failed — rebuilding from the event log: ${e}`).pipe(Effect.map(() => null))
      )
    )

    // A usable persisted state must match this build's fold version AND decode.
    let resume: State | null = null
    if (loaded !== null && loaded.foldVersion === FOLD_VERSIONS.projects) {
      const exit = Schema.decodeUnknownExit(ProjectsFromJson)(loaded.state)
      if (Exit.isSuccess(exit)) {
        resume = { projects: exit.value, seq: loaded.lastSeq }
      } else {
        yield* Effect.logWarning(`projection state undecodable — rebuilding from the event log`)
      }
    }

    // Cheap boot observability (spec §3.5): count + time the fold so future
    // tuning decisions are anchored in data, not folklore.
    let folded = 0
    // The one shared fold (Project.foldList), streamed: the log is keyset-paginated
    // under ProjectEventStore.read, never materialized as one array. A from-zero
    // rebuild is just a tail catch-up starting at seq 0.
    const start: State = resume ?? { projects: [], seq: 0 }
    const [elapsed, initial] = yield* Effect.timed(
      Stream.runFold(events.read(start.seq), () => start, (acc, se: SequencedEvent) => {
        folded++
        return { projects: Project.foldList(acc.projects, se.event), seq: se.seq }
      }).pipe(Effect.orDie)
    )
    yield* Effect.logInfo(
      resume === null
        ? `projection boot: full rebuild folded ${folded} events to seq ${initial.seq} in ${Duration.toMillis(elapsed)}ms`
        : `projection boot: tail catch-up folded ${folded} events (seq ${start.seq} → ${initial.seq}) in ${Duration.toMillis(elapsed)}ms`
    )
    yield* saveCheckpoint(initial)

    const ref = yield* SubscriptionRef.make<State>(initial)

    // ---- checkpoint cadence (spec §3.5, D6) ----
    // Finalizer FIRST, fiber SECOND: scoped finalizers run in reverse, so
    // teardown interrupts the debounce fiber before the final write — no race
    // between an in-flight debounced UPSERT and the closing SQLite pool.
    yield* Effect.addFinalizer(() =>
      SubscriptionRef.get(ref).pipe(Effect.flatMap(saveCheckpoint))
    )
    // The fiber only ever READS consistent {projects, seq} pairs (C2) and
    // persists them; the commit path is untouched. A checkpoint may lag the
    // newest commit — harmless: it is valid at the seq it was taken, boot
    // replays the tail. Debounce starvation under sustained sub-500ms writes is
    // theoretical at human pace; the shutdown finalizer bounds it regardless.
    yield* SubscriptionRef.changes(ref).pipe(
      Stream.debounce(Duration.millis(CHECKPOINT_DEBOUNCE_MS)),
      Stream.runForEach(saveCheckpoint),
      Effect.forkScoped
    )

    const apply = (sequenced: SequencedEvent) =>
      SubscriptionRef.modify(ref, (s) =>
        sequenced.seq <= s.seq
          ? [false, s] as const
          : [true, { projects: Project.foldList(s.projects, sequenced.event), seq: sequenced.seq }] as const
      )

    return {
      list: Effect.map(SubscriptionRef.get(ref), (s) => s.projects),
      snapshot: SubscriptionRef.get(ref),
      apply
    } as const
  })
}) {}

export const ProjectProjectionLayer = Layer.effect(ProjectProjection, ProjectProjection.make)

interface State {
  readonly projects: ReadonlyArray<Project>
  readonly seq: number
}
