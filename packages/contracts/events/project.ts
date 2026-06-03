import { Effect, Schema } from "effect"
import { DESCRIPTION_MAX_LENGTH, Tag } from "@yodea/contracts/project"
import { domainEvent } from "@yodea/contracts/events/meta"

const ProjectEventMeta = {
  projectId: Schema.String
}

const projectEvent = <const T extends string, const F extends Schema.Struct.Fields>(tag: T, fields: F) =>
  domainEvent(tag, { ...ProjectEventMeta, ...fields })

export const ProjectCreated = projectEvent("ProjectCreated", {
  name: Schema.String,
  directory: Schema.optionalKey(Schema.NullOr(Schema.String)).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null)))
})

export const ProjectRenamed = projectEvent("ProjectRenamed", {
  name: Schema.String
})

export const ProjectDirectoryChanged = projectEvent("ProjectDirectoryChanged", {
  directory: Schema.String
})

export const ProjectArchived = projectEvent("ProjectArchived", {})

export const ProjectRestored = projectEvent("ProjectRestored", {})

export const ProjectMetadataChanged = projectEvent("ProjectMetadataChanged", {
  description: Schema.optionalKey(Schema.NullOr(Schema.String.pipe(Schema.check(Schema.isMaxLength(DESCRIPTION_MAX_LENGTH))))),
  tags: Schema.optionalKey(Schema.Array(Tag))
})

export const ProjectDeleted = projectEvent("ProjectDeleted", {})

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
