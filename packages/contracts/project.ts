import { Schema } from "effect"

export const Project = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  createdAt: Schema.String
})
export type Project = typeof Project.Type

export const ProjectCreateResult = Schema.Struct({ created: Schema.Boolean, project: Project })
export type ProjectCreateResult = typeof ProjectCreateResult.Type

// Validated project name (parse-time validation in the CLI; fail fast).
export const ProjectName = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/))
)
export type ProjectName = typeof ProjectName.Type
