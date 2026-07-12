import { Schema } from "effect"
import { ProjectEvent } from "@expand/contracts/events/project"

export const DomainEvent = Schema.Union(Object.values(ProjectEvent.cases)).pipe(Schema.toTaggedUnion("_tag"))

export const DomainEventFromJson = Schema.fromJsonString(DomainEvent)
