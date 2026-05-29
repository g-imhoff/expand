import { Schema } from "effect"

export const Project = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  createdAt: Schema.String
})
export type Project = typeof Project.Type
