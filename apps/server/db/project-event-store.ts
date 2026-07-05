import { Context, Effect, Layer, Stream } from "effect"
import { SqlError } from "effect/unstable/sql/SqlError"
import { ProjectEvent } from "@yodea/contracts/events/project"
import type { SequencedEvent } from "@yodea/contracts/events/domain"
import { EventStore } from "@yodea/server/db/event-store"

// Derived mechanically from the contracts union: a new project event variant
// joins the filter automatically. Pinned by project-event-store.test.ts.
export const PROJECT_EVENT_TAGS: ReadonlyArray<string> = Object.keys(ProjectEvent.cases)

// The first specialized store over the generic EventStore (design D5/D9):
// domain-named reads, no stringly category concept anywhere. When a second
// event family exists and this filter becomes selective, add a partial index
// here (CREATE INDEX ... ON events(seq) WHERE event_type IN (...)).
export class ProjectEventStore extends Context.Service<ProjectEventStore, {
  readonly read: (fromSeq?: number) => Stream.Stream<SequencedEvent, SqlError>
}>()("yodea/ProjectEventStore", {
  make: Effect.gen(function* () {
    const store = yield* EventStore
    return {
      read: (fromSeq = 0) => store.scan({ afterSeq: fromSeq, eventTypes: PROJECT_EVENT_TAGS })
    } as const
  })
}) {}

export const ProjectEventStoreLayer = Layer.effect(ProjectEventStore, ProjectEventStore.make)
