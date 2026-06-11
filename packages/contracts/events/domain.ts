import { Schema } from "effect"
import { ProjectEvent } from "@yodea/contracts/events/project"

export { DomainEventMeta } from "@yodea/contracts/events/meta"

export const DomainEvent = Schema.Union(Object.values(ProjectEvent.cases)).pipe(Schema.toTaggedUnion("_tag"))
export type DomainEvent = typeof DomainEvent.Type

export const DomainEventFromJson = Schema.fromJsonString(DomainEvent)

export const SequencedEvent = Schema.Struct({ seq: Schema.Int, event: DomainEvent })
export type SequencedEvent = typeof SequencedEvent.Type
