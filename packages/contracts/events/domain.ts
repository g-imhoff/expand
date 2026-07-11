import { Schema } from "effect"
import {
  DomainEvent as DomainEventSchema,
  DomainEventFromJson as DomainEventFromJsonSchema
} from "./domain-event"

export class SequencedEvent extends Schema.Opaque<SequencedEvent>()(
  Schema.Struct({ seq: Schema.Int, event: DomainEventSchema })
) {}

export { DomainEventSchema as DomainEvent }
export type DomainEvent = typeof DomainEventSchema.Type

export { DomainEventFromJsonSchema as DomainEventFromJson }
