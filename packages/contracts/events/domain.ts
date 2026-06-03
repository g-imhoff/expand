import { Schema } from "effect"
import { ProjectEvent } from "@yodea/contracts/events/project"

export { DomainEventMeta } from "@yodea/contracts/events/meta"

export const DomainEvent = ProjectEvent
export type DomainEvent = typeof DomainEvent.Type
export type DomainEventEncoded = Schema.Codec.Encoded<typeof DomainEvent>

export const DomainEventFromJson = Schema.fromJsonString(DomainEvent)
