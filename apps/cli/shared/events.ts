import { Schema } from "effect"

// One event type today. As the domain grows, replace the alias below with
// `Schema.Union([ProjectCreated, ProjectRenamed, ...])`; the projection fold
// already switches on `_tag`, so adding a case is the only other change.
export const ProjectCreated = Schema.TaggedStruct("ProjectCreated", {
  projectId: Schema.String,
  name: Schema.String,
  createdAt: Schema.String
})

export const DomainEvent = ProjectCreated
export type DomainEvent = typeof DomainEvent.Type
export type DomainEventEncoded = Schema.Codec.Encoded<typeof DomainEvent>

// Encode/decode a DomainEvent to/from JSON text (used by the event log and RPC).
export const DomainEventFromJson = Schema.fromJsonString(DomainEvent)
