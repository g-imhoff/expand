import { Effect, Schema } from "effect"
import { DESCRIPTION_MAX_LENGTH, Tag } from "@yodea/contracts/project"

export const ProjectCreated = Schema.TaggedStruct("ProjectCreated", {
  projectId: Schema.String,
  name: Schema.String,
  directory: Schema.optionalKey(Schema.NullOr(Schema.String)).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  createdAt: Schema.String
})

export const ProjectRenamed = Schema.TaggedStruct("ProjectRenamed", {
  projectId: Schema.String,
  name: Schema.String,
  occurredAt: Schema.String
})

export const ProjectDirectoryChanged = Schema.TaggedStruct("ProjectDirectoryChanged", {
  projectId: Schema.String,
  directory: Schema.String,
  occurredAt: Schema.String
})

export const ProjectArchived = Schema.TaggedStruct("ProjectArchived", {
  projectId: Schema.String,
  occurredAt: Schema.String
})

export const ProjectRestored = Schema.TaggedStruct("ProjectRestored", {
  projectId: Schema.String,
  occurredAt: Schema.String
})

export const ProjectMetadataChanged = Schema.TaggedStruct("ProjectMetadataChanged", {
  projectId: Schema.String,
  description: Schema.optionalKey(Schema.NullOr(Schema.String.pipe(Schema.check(Schema.isMaxLength(DESCRIPTION_MAX_LENGTH))))),
  tags: Schema.optionalKey(Schema.Array(Tag)),
  occurredAt: Schema.String
})

export const ProjectDeleted = Schema.TaggedStruct("ProjectDeleted", {
  projectId: Schema.String,
  occurredAt: Schema.String
})

export const ProjectEvent = Schema.Union([
  ProjectCreated,
  ProjectRenamed,
  ProjectDirectoryChanged,
  ProjectArchived,
  ProjectRestored,
  ProjectMetadataChanged,
  ProjectDeleted
])
export type ProjectEvent = typeof ProjectEvent.Type
