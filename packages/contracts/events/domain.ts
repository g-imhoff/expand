import { Schema } from "effect"
import { ProjectEvent } from "@yodea/contracts/events/project"

export { DomainEventMeta } from "@yodea/contracts/events/meta"

export const DomainEvent = Schema.Union(Object.values(ProjectEvent.cases)).pipe(Schema.toTaggedUnion("_tag"))
export type DomainEvent = typeof DomainEvent.Type

export const DomainEventFromJson = Schema.fromJsonString(DomainEvent)

export class SequencedEvent extends Schema.Opaque<SequencedEvent>()(
  Schema.Struct({ seq: Schema.Int, event: DomainEvent })
) {}
