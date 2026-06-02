import { Effect, Schema } from "effect"

// One event type today. As the domain grows, replace the alias below with
// `Schema.Union([ProjectCreated, ProjectRenamed, ...])`; the projection fold
// already switches on `_tag`, so adding a case is the only other change.
//
// `directory` is optional on the encoded side (legacy persisted events lack it)
// and decodes to null when absent — keeps the event log backward-compatible.
// NOTE: the v4 beta `withDecodingDefaultKey` takes an Effect default value (not a
// thunk) — the plan's `() => null` is spelled `Effect.succeed(null)` here.
export const ProjectCreated = Schema.TaggedStruct("ProjectCreated", {
  projectId: Schema.String,
  name: Schema.String,
  directory: Schema.optionalKey(Schema.NullOr(Schema.String)).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  createdAt: Schema.String
})

// A project was renamed. `occurredAt` is the ISO event time the fold uses to
// stamp `updatedAt`.
export const ProjectRenamed = Schema.TaggedStruct("ProjectRenamed", {
  projectId: Schema.String,
  name: Schema.String,
  occurredAt: Schema.String
})

export const DomainEvent = Schema.Union([ProjectCreated, ProjectRenamed])
export type DomainEvent = typeof DomainEvent.Type
export type DomainEventEncoded = Schema.Codec.Encoded<typeof DomainEvent>

// Encode/decode a DomainEvent to/from JSON text (used by the event log and RPC).
export const DomainEventFromJson = Schema.fromJsonString(DomainEvent)
