import { Schema } from "effect"
import { AutomationEvent } from "@expand/contracts/events/automation"
import { ProjectEvent } from "@expand/contracts/events/project"

export const DomainEvent = Schema.Union([...Object.values(ProjectEvent.cases), ...Object.values(AutomationEvent.cases)]).pipe(Schema.toTaggedUnion("_tag"))

export const DomainEventFromJson = Schema.fromJsonString(DomainEvent)
