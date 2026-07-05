import { Context, Effect, Layer, Stream } from "effect"
import { SqlError } from "effect/unstable/sql/SqlError"
import { ProjectEvent } from "@yodea/contracts/events/project"
import type { SequencedEvent } from "@yodea/contracts/events/domain"
import { specializeEventStore } from "@yodea/server/db/event-store"

// Derived mechanically from the contracts union; pinned by project-event-store.test.ts.
// When a second event family makes this filter selective, add a partial index
// (CREATE INDEX ... ON events(seq) WHERE event_type IN (...)).
export const PROJECT_EVENT_TAGS: ReadonlyArray<string> = Object.keys(ProjectEvent.cases)

export class ProjectEventStore extends Context.Service<ProjectEventStore, {
  readonly read: (fromSeq?: number) => Stream.Stream<SequencedEvent, SqlError>
  readonly append: (event: ProjectEvent) => Effect.Effect<number, SqlError>
}>()("yodea/ProjectEventStore", {
  make: specializeEventStore((store) => ({
    read: (fromSeq = 0) => store.scan({ afterSeq: fromSeq, eventTypes: PROJECT_EVENT_TAGS }),
    append: (event: ProjectEvent) => store.append(event.projectId, event)
  }))
}) {}

export const ProjectEventStoreLayer = Layer.effect(ProjectEventStore, ProjectEventStore.make)
