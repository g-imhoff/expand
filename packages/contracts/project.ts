import { Effect, Schema } from "effect"
import type { Brand } from "effect"

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

export class Project extends Schema.Opaque<Project, Brand.Brand<"Project">>()(
  Schema.Struct({
    id: ProjectId,
    name: ProjectName,
    directory: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
    description: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
    tags: Schema.Array(Tag).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
    archived: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
    createdAt: Schema.String,
    updatedAt: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("")))
  })
) {}

export class ProjectCreateResult extends Schema.Opaque<ProjectCreateResult>()(
  Schema.Struct({ created: Schema.Boolean, project: Project })
) {}

export class ProjectDeleteResult extends Schema.Opaque<ProjectDeleteResult>()(
  Schema.Struct({ id: Schema.String, deleted: Schema.Boolean })
) {}
