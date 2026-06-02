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

// A project id on the wire/CLI parse layer: a v4 UUID. (Storage keeps plain
// String for compat; this is the validated parse type used by the CLI/RPC.)
export const ProjectId = Schema.String.pipe(Schema.check(Schema.isUUID(4)))
export type ProjectId = typeof ProjectId.Type

// A project tag: kebab-case, reusing the ProjectName pattern.
export const Tag = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/)))
export type Tag = typeof Tag.Type

export const DESCRIPTION_MAX_LENGTH = 2048
