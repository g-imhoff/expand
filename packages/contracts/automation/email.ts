import { Schema } from "effect"
import { LocalId } from "./ids.js"

export const EmailTriggerConfiguration = Schema.Struct({})
export const EmailMessagePayload = Schema.Struct({
  messageId: Schema.String.check(Schema.isMinLength(1)),
  threadId: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  subject: Schema.optional(Schema.String),
  from: Schema.optional(Schema.String),
  snippet: Schema.optional(Schema.String),
  body: Schema.optional(Schema.String)
})
export const EmailLabelArguments = Schema.Struct({
  messageId: Schema.String.check(Schema.isMinLength(1)),
  addLabelIds: Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(Schema.isMinLength(1)),
  removeLabelIds: Schema.optional(Schema.Array(Schema.String.check(Schema.isMinLength(1))))
})
export const EmailLabelResult = Schema.Struct({ applied: Schema.Boolean })
export const EmailNotifications = Schema.Struct({
  onMatch: Schema.Boolean,
  onNoMatch: Schema.Boolean
})
export const EmailClassificationConfiguration = Schema.Struct({
  categories: Schema.Array(LocalId).check(Schema.isMinLength(1), Schema.isUnique()),
  labels: Schema.Record(Schema.String, Schema.String.check(Schema.isMinLength(1))),
  moves: Schema.optional(Schema.Record(Schema.String, Schema.String.check(Schema.isMinLength(1)))),
  notifications: EmailNotifications
})
export const EmailMailboxConfiguration = Schema.Struct({
  mailbox: Schema.optional(Schema.String.check(Schema.isMinLength(1)))
})
