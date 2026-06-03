import { Schema } from "effect"

export const DomainEventMeta = {
  occurredAt: Schema.String
}

export const domainEvent = <const T extends string, const F extends Schema.Struct.Fields>(tag: T, fields: F) =>
  Schema.TaggedStruct(tag, { ...DomainEventMeta, ...fields })
