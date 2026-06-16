import { Context, Effect, Layer, SubscriptionRef } from "effect"
import { Project } from "@yodea/contracts/project"
import { FOLD_VERSION } from "@yodea/contracts/fold-version.generated"
import type { SequencedEvent } from "@yodea/contracts/events/domain"
import { EventStore } from "@yodea/server/db/event-store"
import { SnapshotStore } from "@yodea/server/db/snapshot-store"
import { projectsFromEvents } from "@yodea/server/domain/project"

export class ProjectProjection extends Context.Service<ProjectProjection, {
  readonly list: Effect.Effect<ReadonlyArray<Project>>
  readonly snapshot: Effect.Effect<State>
  // Advance the in-memory read model with a freshly committed event. Idempotent:
  // an event whose seq is not ahead of the current state is a no-op. Returns true
  // iff it was applied. Called by the single writer inside commit().
  readonly apply: (sequenced: SequencedEvent) => Effect.Effect<boolean>
}>()("yodea/ProjectProjection", {
  make: Effect.gen(function* () {
    const store = yield* EventStore
    const snapshots = yield* SnapshotStore

    // ---- boot catch-up: runs once at layer build; single non-concurrent writer ----
    // The snapshot is a DISPOSABLE cache (design §6): a save failure is non-fatal
    // (warn, continue — next boot just folds a longer tail). The event LOG is the
    // source of truth, so a log-read failure is a hard defect (orDie).
    const saveSnapshot = (s: State) =>
      snapshots.save({ projects: s.projects, seq: s.seq, foldVersion: FOLD_VERSION }).pipe(
        Effect.catch((e) =>
          Effect.logWarning(`snapshot save failed at boot — continuing (next boot folds a longer tail): ${e}`)
        )
      )

    // Load failure for ANY reason (absent / undecodable / SQL error) → fall back to
    // a from-zero rebuild rather than failing to boot.
    const snap = yield* snapshots.load.pipe(
      Effect.catch((e) =>
        Effect.logWarning(`snapshot load failed — rebuilding from the event log: ${e}`).pipe(Effect.map(() => null))
      )
    )

    let initial: State
    if (snap === null || snap.foldVersion !== FOLD_VERSION) {
      // No usable snapshot → rebuild from zero (the proven path) and write a fresh one.
      const rows = yield* store.readAll.pipe(Effect.orDie)
      initial = {
        projects: projectsFromEvents(rows.map((r) => r.event)),
        seq: rows.length > 0 ? rows[rows.length - 1]!.seq : 0
      }
      yield* saveSnapshot(initial)
    } else {
      // Usable snapshot → fold only events after snap.seq onto snap.projects.
      const tail = yield* store.readFrom(snap.seq).pipe(Effect.orDie)
      const projects = tail.reduce((acc, se) => Project.foldList(acc, se.event), snap.projects)
      const seq = tail.length > 0 ? tail[tail.length - 1]!.seq : snap.seq
      initial = { projects, seq }
      if (tail.length > 0) yield* saveSnapshot(initial)
    }

    const ref = yield* SubscriptionRef.make<State>(initial)

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
