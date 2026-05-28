import { Schema } from "effect"

export const Session = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  createdAt: Schema.String
})
export type Session = typeof Session.Type
