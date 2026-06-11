import { Effect, Schema } from "effect"

export const ProjectName = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/)),
  Schema.brand("ProjectName")
)
export type ProjectName = typeof ProjectName.Type

export const ProjectId = Schema.String.pipe(
  Schema.check(Schema.isUUID(4)),
  Schema.brand("ProjectId")
)
export type ProjectId = typeof ProjectId.Type

export const Tag = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/)),
  Schema.brand("Tag")
)
export type Tag = typeof Tag.Type

export const DESCRIPTION_MAX_LENGTH = 2048

export const Project = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  directory: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  description: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  tags: Schema.Array(Tag).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  archived: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  createdAt: Schema.String,
  updatedAt: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("")))
})
export type Project = typeof Project.Type

export const ProjectCreateResult = Schema.Struct({ created: Schema.Boolean, project: Project })
export type ProjectCreateResult = typeof ProjectCreateResult.Type

export const ProjectDeleteResult = Schema.Struct({ id: Schema.String, deleted: Schema.Boolean })
export type ProjectDeleteResult = typeof ProjectDeleteResult.Type
