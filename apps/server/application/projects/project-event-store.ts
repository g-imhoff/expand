import { Context, Effect, Layer, Stream } from "effect"
import { SqlError } from "effect/unstable/sql/SqlError"
import { ProjectEvent } from "@expand/contracts/events/project"
import type { SequencedEvent } from "@expand/contracts/events/domain"
import { specializeEventStore } from "@expand/server/db/event-store"

export class ProjectEventStore extends Context.Service<ProjectEventStore, {
  readonly read: (fromSeq?: number) => Stream.Stream<SequencedEvent, SqlError>
  readonly append: (event: ProjectEvent) => Effect.Effect<number, SqlError>
}>()("expand/ProjectEventStore", {
  make: specializeEventStore((store) => ({
    read: (fromSeq = 0) => store.scan({ afterSeq: fromSeq, eventTypes: PROJECT_EVENT_TAGS }),
    append: (event: ProjectEvent) => store.append(event.projectId, event)
  }))
}) {}

// Derived mechanically from the contracts union; pinned by project-event-store.test.ts.
// The cast is sound by TaggedUnion construction (the keys of `cases` ARE the tags);
// Object.keys always widens to string[]. When a second event family makes this filter
// selective, add a partial index (CREATE INDEX ... ON events(seq) WHERE event_type IN (...)).
export const PROJECT_EVENT_TAGS: ReadonlyArray<ProjectEvent["_tag"]> = Object.keys(
  ProjectEvent.cases
) as ReadonlyArray<ProjectEvent["_tag"]>

export const ProjectEventStoreLayer = Layer.effect(ProjectEventStore, ProjectEventStore.make)
